"""Offline protocol/error regressions for the live browser helper."""
import importlib.machinery
import importlib.util
from pathlib import Path
import struct
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

loader = importlib.machinery.SourceFileLoader("page_browser", str(Path(__file__).with_name("rakazo-page-browser")))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class PageBrowserTest(unittest.TestCase):
    def test_closed_stdin_cancels_helper_without_a_browser(self):
        with subprocess.Popen([sys.executable, str(Path(__file__).with_name("rakazo-page-browser")), "snapshot", "{}"],
                              env={**os.environ, "RAKAZO_BROWSER_WATCH_STDIN": "1", "RAKAZO_CDP_PORT": "0"},
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            process.stdin.close()
            self.assertEqual(process.wait(timeout=3), 130)

    def test_closed_extended_frame_does_not_spin(self):
        for partial in (b"\x81\x7e", b"\x81\x7f", b"\x81\x80"):
            with self.subTest(partial=partial):
                client = helper.CdpClient("ws://127.0.0.1:9222/test")
                client._sock = Mock()
                client._sock.recv.return_value = b""
                client._buf.extend(partial)
                with self.assertRaisesRegex(RuntimeError, "closed"):
                    client._read_frame()

    def test_bounds_frame_before_reading_payload(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        client._buf.extend(b"\x81\x7f" + struct.pack("!Q", 10_000_000))
        with self.assertRaisesRegex(RuntimeError, "too large"):
            client._read_frame()
        client._sock.recv.assert_not_called()

    def test_rejects_url_credentials_before_navigation(self):
        client = Mock()
        for url in ("http://example:fake-password@example.test", "https://example:fake-password@example.test"):
            with self.assertRaisesRegex(RuntimeError, "credentials"):
                helper.navigate(client, "session", url)
        client.call.assert_not_called()

    def test_rejects_navigation_error(self):
        client = Mock()
        client.call.return_value = {"errorText": "net::ERR_NAME_NOT_RESOLVED"}
        with self.assertRaisesRegex(RuntimeError, "ERR_NAME_NOT_RESOLVED"):
            helper.navigate(client, "session", "https://example.test")

    def test_preserves_completed_actions_when_next_response_is_lost(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}, True, TimeoutError("lost response")]
            result = helper.act(Mock(), "session", [
                {"kind": "click", "ref": "first"}, {"kind": "click", "ref": "second"},
            ])
        self.assertEqual(result["completed"], 1)
        self.assertTrue(result["uncertain"])
        self.assertFalse(result["ok"])

    def test_rejects_missing_text_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "Text"):
                helper.act(Mock(), "session", [{"kind": "fill", "ref": "first"}])
            ensure.assert_not_called()

    def test_binds_saved_login_fill_to_its_origin_in_the_same_evaluation(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [
                {"kind": "fill", "ref": "e1", "text": "fake-password", "origin": "https://login.example.test"},
            ])
        self.assertEqual(
            evaluate.call_args_list[1].args[2],
            'window.__rakazoPageBrowser.fill("e1", "fake-password", "https://login.example.test")',
        )

    def test_rejects_origin_outside_fill_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "origin"):
                helper.act(Mock(), "session", [
                    {"kind": "type", "ref": "e1", "text": "x", "origin": "https://login.example.test"},
                ])
            ensure.assert_not_called()

    def test_snapshot_is_extended_only_on_request(self):
        with patch.object(helper, "ensure_helpers"), \
                patch.object(helper, "eval_json", return_value={"elements": []}) as evaluate:
            helper.snapshot(Mock(), "session")
            helper.snapshot(Mock(), "session", True)
        self.assertEqual(
            [call.args[2] for call in evaluate.call_args_list],
            ["window.__rakazoPageBrowser.snapshot(false, 0)", "window.__rakazoPageBrowser.snapshot(true, 0)"],
        )

    def test_snapshot_reads_on_from_a_whole_number_text_offset_only(self):
        with patch.object(helper, "ensure_helpers"), \
                patch.object(helper, "eval_json", return_value={"elements": []}) as evaluate:
            helper.snapshot(Mock(), "session", False, 6000)
            with self.assertRaises(ValueError):
                helper.snapshot(Mock(), "session", False, "0); alert(1")
        self.assertEqual(
            [call.args[2] for call in evaluate.call_args_list],
            ["window.__rakazoPageBrowser.snapshot(false, 6000)"],
        )

    def test_screenshot_reports_the_device_pixel_ratio(self):
        client = Mock()
        client.call.return_value = {"data": "iVBORw0KGgo="}
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json", side_effect=[2, None]):
            self.assertEqual(helper.screenshot(client, "session"), {"ok": True, "data": "iVBORw0KGgo=", "scale": 2})
            self.assertEqual(helper.screenshot(client, "session")["scale"], 1)
        self.assertEqual(client.call.call_args.args[0], "Page.captureScreenshot")

    def test_reads_arguments_from_one_stdin_line_only(self):
        payload = b'{"actions": []}\nrest'
        with patch.object(helper.os, "read", side_effect=[payload[i:i + 1] for i in range(len(payload))]) as read:
            self.assertEqual(helper.read_stdin_line(), '{"actions": []}')
        self.assertEqual(read.call_count, len(b'{"actions": []}\n'))

    def test_discovery_cannot_leave_loopback_endpoint(self):
        with patch.object(helper, "http_get_json", return_value={"webSocketDebuggerUrl": "ws://example.test:9222/session"}):
            with self.assertRaisesRegex(RuntimeError, "Unexpected CDP"):
                helper.discover_ws_url(9222)

    def test_ensure_world_reuses_named_isolated_context(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        calls = []

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append(method)
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "frame-1"}}}
            if method == "Runtime.enable":
                client._handle_event({
                    "method": "Runtime.executionContextCreated",
                    "sessionId": session_id,
                    "params": {
                        "context": {
                            "id": 42,
                            "name": helper.WORLD_NAME,
                            "auxData": {"frameId": "frame-1", "isDefault": False},
                        }
                    },
                })
                return {}
            raise AssertionError(f"unexpected CDP call: {method}")

        client.call = fake_call  # type: ignore[method-assign]
        helper.ensure_world(client, "session-a")
        self.assertEqual(client.context_id, 42)
        self.assertNotIn("Page.createIsolatedWorld", calls)

    def test_context_lookup_rejects_default_foreign_and_unbound_contexts(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        for aux, session in (({"frameId": "frame-1", "isDefault": True}, "session-a"),
                             ({"frameId": "other-frame", "isDefault": False}, "session-a"),
                             ({"frameId": "frame-1", "isDefault": False}, "session-b"),
                             ({}, "session-a")):
            client._handle_event({"method": "Runtime.executionContextCreated", "sessionId": session,
                                  "params": {"context": {"id": 42, "name": helper.WORLD_NAME, "auxData": aux}}})
            self.assertIsNone(client.find_world_context(helper.WORLD_NAME, "frame-1", "session-a"))

    def test_ensure_world_creates_when_missing(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "frame-1"}}}
            if method == "Runtime.enable":
                return {}
            if method == "Page.createIsolatedWorld":
                self.assertEqual(params["worldName"], helper.WORLD_NAME)
                return {"executionContextId": 7}
            raise AssertionError(f"unexpected CDP call: {method}")

        client.call = fake_call  # type: ignore[method-assign]
        helper.ensure_world(client, "session-a")
        self.assertEqual(client.context_id, 7)

    def test_upload_paths_must_be_existing_files_inside_home(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            receipt = Path(home, "receipts", "march.pdf")
            receipt.parent.mkdir()
            receipt.write_bytes(b"%PDF-1.4")
            secret = Path(outside, "secret.txt")
            secret.write_text("nope")
            Path(home, "escape.txt").symlink_to(secret)

            self.assertEqual(
                helper.resolve_upload_paths(["receipts/march.pdf"], home),
                [os.path.realpath(receipt)],
            )
            for paths, message in (
                (["../" + Path(outside).name + "/secret.txt"], "inside this computer's home"),
                ([str(secret)], "inside this computer's home"),
                (["escape.txt"], "inside this computer's home"),
                (["receipts/missing.pdf"], "File not found"),
                (["receipts"], "Not a regular file"),
                ([], "1 to 10"),
                (["a"] * 11, "1 to 10"),
                ([""], "non-empty"),
            ):
                with self.subTest(paths=paths), self.assertRaisesRegex(RuntimeError, message):
                    helper.resolve_upload_paths(paths, home)

    def test_upload_confinement_checks_symlinked_parents_without_leaking_targets(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            Path(home, "parent").symlink_to(outside, target_is_directory=True)
            for exists in (False, True):
                if exists:
                    Path(outside, "secret.txt").write_text("secret")
                with self.subTest(exists=exists), self.assertRaises(RuntimeError) as error:
                    helper.resolve_upload_paths(["parent/secret.txt"], home)
                self.assertEqual(str(error.exception),
                                 "Upload files must be inside this computer's home folder: parent/secret.txt")
                self.assertNotIn(outside, str(error.exception))

    def test_team_upload_roots_confine_files_and_roots_after_symlinks(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            for folder in ("bots/b1", "bots/b2", "shared"):
                Path(home, folder).mkdir(parents=True)
            for file in ("bots/b1/own.txt", "bots/b2/secret.txt", "shared/brief.txt", "root.txt"):
                Path(home, file).write_text("fixture")
            Path(home, "bots/b1/link").symlink_to(Path(home, "bots/b2/secret.txt"))
            Path(home, "bots/b1/parent").symlink_to(Path(home, "bots/b2"), target_is_directory=True)
            roots = ["bots/b1", "shared"]
            self.assertEqual(helper.resolve_upload_paths(
                ["bots/b1/own.txt", "shared/brief.txt"], home, roots),
                [str(Path(home, "bots/b1/own.txt").resolve()), str(Path(home, "shared/brief.txt").resolve())])
            for path in ("bots/b1/link", "bots/b1/parent/secret.txt", "root.txt"):
                with self.subTest(path=path), self.assertRaises(RuntimeError) as error:
                    helper.resolve_upload_paths([path], home, roots)
                self.assertEqual(str(error.exception),
                                 f"Upload files must be inside your folder or shared/: {path}")
                self.assertNotIn(home, str(error.exception))
            for root in ("missing", "escaped"):
                if root == "escaped":
                    Path(home, root).symlink_to(outside, target_is_directory=True)
                with self.subTest(root=root), self.assertRaisesRegex(RuntimeError, "your folder or shared/"):
                    helper.resolve_upload_paths(["root.txt"], home, [root])

    def test_team_upload_missing_root_does_not_block_the_other(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            Path(home, "bots/b1").mkdir(parents=True)
            Path(home, "bots/b1/own.txt").write_text("fixture")
            self.assertEqual(
                helper.resolve_upload_paths(["bots/b1/own.txt"], home, ["bots/b1", "shared"]),
                [str(Path(home, "bots/b1/own.txt").resolve())],
            )

    def test_team_upload_rejects_roots_redirected_to_another_bot(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            Path(home, "bots/b2").mkdir(parents=True)
            Path(home, "bots/b2/secret.txt").write_text("fixture")
            Path(home, "bots/b1").symlink_to(Path(home, "bots/b2"), target_is_directory=True)
            Path(home, "shared").symlink_to(Path(home, "bots/b2"), target_is_directory=True)
            for path in ("bots/b1/secret.txt", "shared/secret.txt"):
                with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, "your folder or shared/"):
                    helper.resolve_upload_paths([path], home, ["bots/b1", "shared"])

    def test_upload_rejects_fifo_without_opening_it(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            os.mkfifo(Path(home, "pipe"))
            with patch("builtins.open", side_effect=AssertionError("must not open FIFO")):
                with self.assertRaisesRegex(RuntimeError, "Not a regular file: pipe"):
                    helper.resolve_upload_paths(["pipe"], home)

    def test_upload_absolute_paths_and_literal_tilde(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            file = Path(home, "x")
            file.write_text("fixture")
            self.assertEqual(helper.resolve_upload_paths([str(file)], home), [str(file.resolve())])
            with self.assertRaisesRegex(RuntimeError, "File not found: ~/x"):
                helper.resolve_upload_paths(["~/x"], home)
            for exists in (False, True):
                target = Path(outside, "x")
                if exists:
                    target.write_text("fixture")
                with self.assertRaisesRegex(RuntimeError, "must be inside"):
                    helper.resolve_upload_paths([str(target)], home)

    def test_upload_total_size_limit(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            for name in ("a", "b"):
                Path(home, name).write_bytes(b"123")
            with patch.dict(os.environ, {"RAKAZO_BROWSER_UPLOAD_MAX_BYTES": "5"}):
                self.assertEqual(helper.resolve_upload_paths(["a"], home), [str(Path(home, "a").resolve())])
                with self.assertRaisesRegex(RuntimeError, "upload files are larger than .* MB in total"):
                    helper.resolve_upload_paths(["a", "b"], home)
            for override in ("invalid", "0", "-1"):
                with patch.dict(os.environ, {"RAKAZO_BROWSER_UPLOAD_MAX_BYTES": override}):
                    self.assertEqual(len(helper.resolve_upload_paths(["a", "b"], home)), 2)
            with patch.dict(os.environ, {}, clear=True):
                with patch.object(helper.os, "stat", return_value=Mock(
                        st_mode=0o100644, st_size=helper.MAX_UPLOAD_BYTES + 1)):
                    with self.assertRaisesRegex(RuntimeError, "larger than 100 MB in total"):
                        helper.resolve_upload_paths(["a"], home)

    def test_upload_act_passes_trusted_roots_before_touching_the_page(self):
        with patch.object(helper, "resolve_upload_paths", side_effect=RuntimeError("confined")) as resolve:
            with patch.object(helper, "ensure_helpers") as ensure:
                with self.assertRaisesRegex(RuntimeError, "confined"):
                    helper.act(Mock(), "session", [{"kind": "upload", "ref": "e1",
                               "paths": ["bots/b1/file"], "roots": ["bots/b1", "shared"]}])
            resolve.assert_called_once_with(["bots/b1/file"], roots=["bots/b1", "shared"])
            ensure.assert_not_called()

    def test_upload_sets_files_on_the_input_without_a_file_chooser(self):
        client = Mock()
        client.context_id = 7
        client.call.side_effect = [{"result": {"objectId": "node-1"}}, {}, {}]
        helper.upload(client, "session", "e1", ["/home/rakazo/receipt.pdf"])
        methods = [call.args[0] for call in client.call.call_args_list]
        self.assertEqual(methods, ["Runtime.evaluate", "DOM.setFileInputFiles", "Runtime.releaseObject"])
        self.assertEqual(
            client.call.call_args_list[1].args[1],
            {"files": ["/home/rakazo/receipt.pdf"], "objectId": "node-1"},
        )

    def test_upload_rejects_a_bad_path_before_touching_the_page(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "File not found"):
                helper.act(Mock(), "session", [{"kind": "upload", "ref": "e1", "paths": ["nope.pdf"]}])
        ensure.assert_not_called()


class FakeTargets:
    """A CDP stand-in for browser-level target commands."""

    def __init__(self, infos):
        self.infos = infos
        self.calls = []

    def call(self, method, params=None, *, session_id=None, timeout_s=30.0):
        self.calls.append((method, params))
        if method == "Target.getTargets":
            return {"targetInfos": self.infos}
        if method in ("Target.activateTarget", "Page.enable"):
            return {}
        if method == "Target.closeTarget":
            return {"success": True}
        if method == "Target.createTarget":
            return {"targetId": "T-new"}
        if method == "Target.attachToTarget":
            return {"sessionId": f"S-{params['targetId']}"}
        raise AssertionError(f"unexpected CDP call: {method}")


def page(target, url="https://example.test/", title="Example", opener=None):
    info = {"targetId": target, "type": "page", "url": url, "title": title}
    if opener:
        info["openerId"] = opener
    return info


class TabCommandTest(unittest.TestCase):
    def setUp(self):
        self.pins = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.pins, True)
        patcher = patch.object(helper, "PIN_DIR", self.pins)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Never read or move a real X window from a unit test.
        window = patch.object(helper, "active_window", return_value=None)
        window.start()
        self.addCleanup(window.stop)

    def test_lists_page_tabs_only(self):
        client = FakeTargets([
            page("A"), page("B", opener="A"),
            {"targetId": "W", "type": "service_worker", "url": "", "title": ""},
        ])
        self.assertEqual(helper.list_tabs(client), {"ok": True, "tabs": [
            {"target": "A", "title": "Example", "url": "https://example.test/"},
            {"target": "B", "title": "Example", "url": "https://example.test/", "openerId": "A"},
        ]})

    def test_attaching_a_closed_tab_fails_before_attaching(self):
        client = FakeTargets([page("A")])
        with self.assertRaisesRegex(RuntimeError, "That tab is closed."):
            helper.attach_target(client, "gone")
        self.assertNotIn("Target.attachToTarget", [method for method, _ in client.calls])

    def test_reports_only_new_tabs_opened_by_the_acted_tab(self):
        client = FakeTargets([page("A"), page("B", opener="A"), page("C", opener="A"),
                              page("D", opener="X")])
        self.assertEqual(helper.opened_by(client, "A", {"A", "B"}), ["C"])

    def test_follow_activates_when_nothing_is_pinned(self):
        client = FakeTargets([page("A"), page("B")])
        self.assertEqual(helper.activate(client, "B", None),
                         {"ok": True, "front": "B", "pinned": None})
        self.assertIn(("Target.activateTarget", {"targetId": "B"}), client.calls)

    def test_follow_does_not_move_a_pinned_view(self):
        client = FakeTargets([page("A"), page("B")])
        helper.activate(client, "A", True)
        client.calls.clear()
        self.assertEqual(helper.activate(client, "B", None),
                         {"ok": True, "front": None, "pinned": "A"})
        self.assertNotIn("Target.activateTarget", [method for method, _ in client.calls])

    def test_a_pin_on_a_closed_tab_counts_as_unpinned(self):
        helper.activate(FakeTargets([page("A"), page("B")]), "A", True)
        client = FakeTargets([page("B")])
        self.assertEqual(helper.activate(client, "B", None),
                         {"ok": True, "front": "B", "pinned": None})

    def test_unpin_without_a_target_changes_no_tab(self):
        helper.activate(FakeTargets([page("A")]), "A", True)
        client = FakeTargets([page("A")])
        self.assertEqual(helper.activate(client, None, False),
                         {"ok": True, "front": None, "pinned": None})
        self.assertNotIn("Target.activateTarget", [method for method, _ in client.calls])

    def test_pinning_needs_a_target(self):
        with self.assertRaisesRegex(RuntimeError, "target"):
            helper.activate(FakeTargets([page("A")]), None, True)

    def test_open_rejects_a_bad_url_before_creating_a_tab(self):
        client = FakeTargets([page("A")])
        with self.assertRaisesRegex(RuntimeError, "credentials"):
            helper.open_tab(client, "https://user:fake-password@example.test/")
        self.assertEqual(client.calls, [])

    def test_open_creates_a_background_tab_and_navigates_it(self):
        client = FakeTargets([page("A"), page("T-new", url="about:blank", title="")])
        with patch.object(helper, "ensure_world"), \
                patch.object(helper, "navigate", return_value={"ok": True, "url": "https://example.test/", "title": "Example"}) as go:
            result = helper.open_tab(client, "https://example.test/")
        self.assertEqual(result, {"ok": True, "url": "https://example.test/", "title": "Example",
                                  "target": "T-new"})
        self.assertIn(("Target.createTarget", {"url": "about:blank", "background": True,
                                               "newWindow": helper.OPEN_IN_NEW_WINDOW}), client.calls)
        go.assert_called_once_with(client, "S-T-new", "https://example.test/")

    def test_actions_run_as_a_user_gesture(self):
        # Without one, Chromium's popup blocker drops target=_blank links and window.open.
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [{"kind": "click", "ref": "e1"}])
        self.assertEqual(evaluate.call_args_list[1].kwargs, {"user_gesture": True})
        self.assertEqual(evaluate.call_args_list[0].kwargs, {})

    def test_close_waits_until_the_tab_is_gone(self):
        client = FakeTargets([page("A"), page("B")])
        original = client.call

        def closing(method, params=None, **kwargs):
            result = original(method, params, **kwargs)
            if method == "Target.closeTarget":
                client.infos = [page("A")]
            return result

        client.call = closing
        self.assertEqual(helper.close_tab(client, "B"), {"ok": True})
        self.assertIn(("Target.closeTarget", {"targetId": "B"}), client.calls)

    def test_closing_an_unknown_tab_reports_it_closed(self):
        with self.assertRaisesRegex(RuntimeError, "That tab is closed."):
            helper.close_tab(FakeTargets([page("A")]), "gone")

    def test_a_failed_open_closes_the_tab_it_created(self):
        client = FakeTargets([page("A"), page("T-new", url="about:blank", title="")])
        with patch.object(helper, "ensure_world"), \
                patch.object(helper, "navigate", side_effect=RuntimeError("net::ERR_NAME_NOT_RESOLVED")):
            with self.assertRaisesRegex(RuntimeError, "ERR_NAME_NOT_RESOLVED"):
                helper.open_tab(client, "https://example.test/")
        self.assertIn(("Target.closeTarget", {"targetId": "T-new"}), client.calls)

    def test_replies_carry_the_live_pin(self):
        helper.activate(FakeTargets([page("A"), page("B")]), "A", True)
        self.assertEqual(helper.with_pin(FakeTargets([page("A")]), {"ok": True}),
                         {"ok": True, "pinned": "A"})
        self.assertEqual(helper.with_pin(FakeTargets([page("B")]), {"ok": True}),
                         {"ok": True, "pinned": None})

    def test_open_gives_the_screen_back(self):
        client = FakeTargets([page("A"), page("T-new", url="about:blank", title="")])
        with patch.object(helper, "active_window", return_value="42"), \
                patch.object(helper, "activate_window") as restore, patch.object(helper, "ensure_world"), \
                patch.object(helper, "navigate", return_value={"ok": True, "url": "https://example.test/", "title": "Example"}):
            helper.open_tab(client, "https://example.test/")
        restore.assert_called_once_with("42")


if __name__ == "__main__":
    unittest.main()

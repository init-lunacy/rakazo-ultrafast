"""Synthetic sites for the browsing benchmark.

Usage: site_server.py <sites.json> <port> <requests.jsonl>
Pages render from sites.json. Every request except /health is appended to the log.
"""

import html
import json
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

DATA_PATH, PORT, LOG_PATH = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(DATA_PATH, encoding="utf-8") as data_file:
    SITES = json.load(data_file)
PRODUCTS = sorted(SITES["shop"]["products"], key=lambda product: product["name"])
PRODUCTS_BY_ID = {product["id"]: product for product in PRODUCTS}
PAGE_SIZE = SITES["shop"]["pageSize"]
CHECKOUT_FIELDS = ("name", "street", "city", "postcode")


def esc(value):
    return html.escape(str(value), quote=True)


def document(title, body, script=""):
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        f"<title>{esc(title)}</title></head><body>{body}{script}</body></html>"
    )


def price(product):
    return f"${product['price']:.2f}"


def first(values, name, default=""):
    return values.get(name, [default])[0].strip()


def page_number(raw):
    return int(raw) if raw.isdigit() and int(raw) > 0 else 1


def shop_page(query):
    text = first(query, "q")
    category = first(query, "category")
    matches = [
        product
        for product in PRODUCTS
        if (not text or text.lower() in product["name"].lower())
        and (not category or product["category"] == category)
    ]
    pages = max(1, -(-len(matches) // PAGE_SIZE))
    number = min(page_number(first(query, "page", "1")), pages)
    shown = matches[(number - 1) * PAGE_SIZE : number * PAGE_SIZE]
    options = "".join(
        f"<option value='{esc(name)}'{' selected' if name == category else ''}>{esc(name.title())}</option>"
        for name in sorted({product["category"] for product in PRODUCTS})
    )
    items = "".join(
        f"<li><a href='/shop/item/{esc(product['id'])}'>{esc(product['name'])}</a> {price(product)}</li>"
        for product in shown
    )

    def link(target, label):
        query_string = urlencode({"q": text, "category": category, "page": target})
        return f"<a href='/shop?{esc(query_string)}'>{label}</a> "

    nav = (link(number - 1, "Previous page") if number > 1 else "") + (
        link(number + 1, "Next page") if number < pages else ""
    )
    body = (
        "<h1>Trailhead Outfitters</h1><form action='/shop'>"
        f"<label>Search <input name='q' value='{esc(text)}'></label> "
        f"<label>Category <select name='category'><option value=''>All</option>{options}</select></label> "
        "<button>Search</button></form>"
        f"<p>Page {number} of {pages} ({len(matches)} products)</p><ul>{items}</ul><nav>{nav}</nav>"
    )
    return document("Shop", body)


def item_page(product):
    specs = "".join(
        f"<tr><th>{esc(name.title())}</th><td>{esc(value)}</td></tr>"
        for name, value in product["specs"].items()
    )
    buy = f"<p><a href='/checkout?item={esc(product['id'])}'>Buy</a></p>" if product["inStock"] else ""
    body = (
        f"<h1>{esc(product['name'])}</h1><p>{price(product)}</p>"
        f"<p>Waterproof: {'Yes' if product['waterproof'] else 'No'}</p>"
        f"<p>Sizes: {esc(', '.join(product['sizes']) or 'One size')}</p>"
        f"<p>{'In stock' if product['inStock'] else 'Out of stock'}</p>"
        f"<table><caption>Specs</caption>{specs}</table>{buy}"
        "<p><a href='/shop'>Back to shop</a></p>"
    )
    return document(product["name"], body)


def hidden(fields):
    return "".join(
        f"<input type='hidden' name='{esc(name)}' value='{esc(value)}'>" for name, value in fields.items()
    )


def checkout_details(product):
    inputs = "".join(
        f"<p><label>{esc(name.title())} <input name='{name}' required></label></p>" for name in CHECKOUT_FIELDS
    )
    body = (
        f"<h1>Checkout: {esc(product['name'])}</h1><h2>Step 1 of 2: Your details</h2>"
        f"<form method='post' action='/checkout/details'>{hidden({'item': product['id']})}{inputs}"
        "<button>Continue</button></form>"
    )
    return document("Checkout", body)


def checkout_options(fields):
    product = PRODUCTS_BY_ID[fields["item"]]
    carried = {name: fields[name] for name in ("item", *CHECKOUT_FIELDS)}
    shipping = "".join(
        f"<option value='{esc(option)}'>{esc(option.title())}</option>" for option in SITES["checkout"]["shipping"]
    )
    body = (
        f"<h1>Checkout: {esc(product['name'])}</h1><h2>Step 2 of 2: Quantity and shipping</h2>"
        f"<form method='post' action='/checkout/confirm'>{hidden(carried)}"
        "<p><label>Quantity <input name='quantity' type='number' min='1' value='1'></label></p>"
        f"<p><label>Shipping <select name='shipping'>{shipping}</select></label></p>"
        "<button>Place order</button></form>"
    )
    return document("Checkout", body)


def confirmation(order_number):
    body = f"<h1>Order confirmed</h1><p>Your order number is <strong>{esc(order_number)}</strong>.</p>"
    return document("Order confirmed", body)


def article_page():
    article = SITES["article"]
    sections = "".join(
        f"<section><h2>{esc(section['heading'])}</h2><p>{esc(section['text'])}</p></section>"
        for section in article["sections"]
    )
    body = (
        "<div id='cookie-banner' role='dialog' aria-label='Cookie consent'>"
        "<p>We use cookies to improve this site.</p><button id='accept-cookies'>Accept cookies</button></div>"
        f"<main id='article' hidden><h1>{esc(article['title'])}</h1>{sections}"
        "<div id='late'><p>Loading more…</p></div></main>"
    )
    script = (
        "<script>document.getElementById('accept-cookies').onclick = () => {"
        "document.getElementById('cookie-banner').remove();"
        "document.getElementById('article').hidden = false;"
        "setTimeout(async () => { document.getElementById('late').innerHTML = "
        f"await (await fetch('/article/late')).text(); }}, {int(article['lateDelayMs'])});"
        "};</script>"
    )
    return document(article["title"], body, script)


def late_fragment():
    late = SITES["article"]["lateSection"]
    return f"<section><h2>{esc(late['heading'])}</h2><p>{esc(late['text'])}</p></section>"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def record(self, path, query, fields, order_number=None):
        entry = {
            "method": self.command,
            "path": path,
            "query": {name: values[0] for name, values in query.items()},
            "fields": fields,
            "userAgent": self.headers.get("User-Agent", ""),
        }
        if order_number:
            entry["orderNumber"] = order_number
        with open(LOG_PATH, "a", encoding="utf-8") as log:
            log.write(json.dumps(entry) + "\n")

    def reply(self, status, content, content_type="text/html; charset=utf-8"):
        payload = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.reply(200, "ok", "text/plain; charset=utf-8")
        query = parse_qs(url.query)
        self.record(url.path, query, {})
        item = url.path.removeprefix("/shop/item/")
        if url.path in ("/", "/shop"):
            return self.reply(200, shop_page(query))
        if url.path.startswith("/shop/item/") and item in PRODUCTS_BY_ID:
            return self.reply(200, item_page(PRODUCTS_BY_ID[item]))
        if url.path == "/checkout" and first(query, "item") in PRODUCTS_BY_ID:
            return self.reply(200, checkout_details(PRODUCTS_BY_ID[first(query, "item")]))
        if url.path == "/article":
            return self.reply(200, article_page())
        if url.path == "/article/late":
            return self.reply(200, late_fragment())
        self.reply(404, document("Not found", "<h1>Not found</h1><p><a href='/shop'>Shop</a></p>"))

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        submitted = parse_qs(self.rfile.read(length).decode("utf-8"))
        fields = {name: values[0].strip() for name, values in submitted.items()}
        complete = fields.get("item") in PRODUCTS_BY_ID and all(fields.get(name) for name in CHECKOUT_FIELDS)
        if url.path == "/checkout/details" and complete:
            self.record(url.path, {}, fields)
            return self.reply(200, checkout_options(fields))
        if (
            url.path == "/checkout/confirm"
            and complete
            and fields.get("quantity", "").isdigit()
            and fields.get("shipping") in SITES["checkout"]["shipping"]
        ):
            order_number = f"TO-{secrets.token_hex(3).upper()}"
            self.record(url.path, {}, fields, order_number)
            return self.reply(200, confirmation(order_number))
        self.record(url.path, {}, fields)
        self.reply(400, document("Check your details", "<h1>Some details are missing</h1><p><a href='/shop'>Back to shop</a></p>"))


# Created up front, so a missing log means a broken harness rather than an idle bot.
open(LOG_PATH, "a", encoding="utf-8").close()
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

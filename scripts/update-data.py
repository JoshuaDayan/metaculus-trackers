#!/usr/bin/env python3
"""Metaculus Tracker Data Updater - Scrapes Yahoo Finance + Bundesbank"""

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

CURRENCIES = ["EUR", "GBP", "JPY", "CNY", "CHF", "AUD", "CAD", "MXN"]
CURRENCY_FILE = Path("february-2026-currency-tracker.html")
BOND_FILE = Path("german-bond-tracker.html")


def fetch_yahoo_currency(code: str):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}USD=X"
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        price = r.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
        return round(float(price), 6)
    except Exception:
        return None


def fetch_bundesbank_yield():
    url = "https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A"
    try:
        r = requests.get(url, headers={"Accept": "application/json"}, timeout=15)
        r.raise_for_status()
        obs = r.json()["data"]["dataSets"][0]["series"]["0:0:0:0:0:0"]["observations"]
        latest_key = max(obs.keys(), key=int)
        return round(float(obs[latest_key][0]), 2)
    except Exception:
        return None


def update_currency_html(rates):
    if not CURRENCY_FILE.exists():
        return False

    content = CURRENCY_FILE.read_text()
    block = "const CURRENT = {\n"
    for code in CURRENCIES:
        if code in rates:
            block += f"            {code}: {rates[code]},\n"
    block = block.rstrip(",\n") + "\n        };"

    content = re.sub(r"const CURRENT = \{[^}]+\};", block, content)

    now = datetime.now(timezone.utc)
    ts = now.strftime("%B %d, %Y at %I:%M %p GMT")
    content = re.sub(
        r'(<span[^>]*id="lastUpdated"[^>]*>)[^<]*(</span>)',
        rf"\g<1>{ts}\2",
        content,
    )

    CURRENCY_FILE.write_text(content)
    print(f"Updated {CURRENCY_FILE}")
    return True


def update_bond_html(yld):
    if not BOND_FILE.exists():
        return False

    content = BOND_FILE.read_text()
    content = re.sub(
        r"const CURRENT_YIELD = [\d.]+;",
        f"const CURRENT_YIELD = {yld};",
        content,
    )

    now = datetime.now(timezone.utc)
    ts = now.strftime("%B %d, %Y at %I:%M %p GMT")
    content = re.sub(
        r'(<span[^>]*id="lastUpdated"[^>]*>)[^<]*(</span>)',
        rf"\g<1>{ts}\2",
        content,
    )

    BOND_FILE.write_text(content)
    print(f"Updated {BOND_FILE}")
    return True


if __name__ == "__main__":
    currency_success = False
    bond_success = False

    # Try currency update first (more complex, might fail)
    print("Fetching currencies from Yahoo Finance...")
    try:
        rates = {c: fetch_yahoo_currency(c) for c in CURRENCIES}
        rates = {k: v for k, v in rates.items() if v}
        if rates:
            print(f"Got rates for: {', '.join(rates.keys())}")
            if update_currency_html(rates):
                currency_success = True
        else:
            print("Warning: No currency rates fetched")
    except Exception as e:
        print(f"Currency update failed: {e}")

    # Always try bond update (simpler, more reliable)
    print("\nFetching bond yield from Deutsche Bundesbank...")
    try:
        yld = fetch_bundesbank_yield()
        if yld:
            print(f"Got yield: {yld}%")
            if update_bond_html(yld):
                bond_success = True
        else:
            print("Warning: No bond yield fetched")
    except Exception as e:
        print(f"Bond update failed: {e}")

    # Summary
    print("\n" + "=" * 40)
    print("Summary:")
    print(f"  Currency tracker: {'SUCCESS' if currency_success else 'FAILED'}")
    print(f"  Bond tracker: {'SUCCESS' if bond_success else 'FAILED'}")

    if not currency_success and not bond_success:
        print("\nBoth updates failed!")
        sys.exit(1)
    elif not currency_success:
        print("\nNote: Currency update failed but bond update succeeded")

    print("\nDone!")

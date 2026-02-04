#!/usr/bin/env python3
"""Metaculus Tracker Data Updater - Scrapes Yahoo Finance + Bundesbank"""

import re
import requests
from datetime import datetime, timezone
from pathlib import Path

CURRENCIES = ['EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'AUD', 'CAD', 'MXN']
CURRENCY_FILE = Path('february-2026-currency-tracker.html')
BOND_FILE = Path('german-bond-tracker.html')

def fetch_yahoo_currency(code):
      url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}USD=X"
      headers = {'User-Agent': 'Mozilla/5.0'}
      try:
                r = requests.get(url, headers=headers, timeout=10)
                return round(r.json()['chart']['result'][0]['meta']['regularMarketPrice'], 6)
            except:
        return None

              def fetch_bundesbank_yield():
                    url = "https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A"
                    try:
                              r = requests.get(url, headers={'Accept': 'application/json'}, timeout=15)
                              obs = r.json()['data']['dataSets'][0]['series']['0:0:0:0:0:0']['observations']
                              return round(float(obs[max(obs.keys(), key=int)][0]), 2)
                          except:
        return None

              def update_currency_html(rates):
                    if not CURRENCY_FILE.exists(): return
                          content = CURRENCY_FILE.read_text()
                    block = "const CURRENT = {\n"
                    for code in CURRENCIES:
                              if code in rates: block += f"            {code}: {rates[code]},\n"
                                    block = block.rstrip(',\n') + "\n        };"
                          content = re.sub(r'const CURRENT = \{[^}]+\};', block, content)
                    now = datetime.now(timezone.utc)
                    ts = now.strftime('%B %d, %Y at %I:%M %p GMT')
                    content = re.sub(r'(<span[^>]*id="lastUpdated"[^>]*>)[^<]*(</span>)', rf'\g<1>{ts}\2', content)
                    CURRENCY_FILE.write_text(content)
                    print(f"Updated {CURRENCY_FILE}")

              def update_bond_html(yld):
                    if not BOND_FILE.exists(): return
                          content = BOND_FILE.read_text()
                    content = re.sub(r'const CURRENT_YIELD = [\d.]+;', f'const CURRENT_YIELD = {yld};', content)
                    now = datetime.now(timezone.utc)
                    ts = now.strftime('%B %d, %Y at %I:%M %p GMT')
                    content = re.sub(r'(<span[^>]*id="lastUpdated"[^>]*>)[^<]*(</span>)', rf'\g<1>{ts}\2', content)
                    BOND_FILE.write_text(content)
                    print(f"Updated {BOND_FILE}")

              if __name__ == '__main__':
                    print("Fetching currencies...")
                    rates = {c: fetch_yahoo_currency(c) for c in CURRENCIES}
                    rates = {k: v for k, v in rates.items() if v}
                    if rates: update_currency_html(rates)

                    print("Fetching bond yield...")
                    yld = fetch_bundesbank_yield()
                    if yld: update_bond_html(yld)

                    print("Done!")

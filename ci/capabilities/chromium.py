#!/usr/bin/python3
"""Expose the prebuilt Playwright Chromium to existing CARR consumers."""
import os
from pathlib import Path
import sys

browser, = Path('/ms-playwright').glob('chromium-*/chrome-linux*/chrome')
os.execv(browser, [str(browser), *sys.argv[1:]])

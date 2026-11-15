"""Account-isolated Chromium processes; raw debugging listeners remain loopback-only."""
from __future__ import annotations

import base64
import math
import os
import secrets
import shutil
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .config import BridgeAuthError


def public_tab_url(value):
    """Expose navigation context without URL credentials or token-bearing suffixes."""
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
            return 'about:blank'
        host = parsed.hostname
        if ':' in host:
            host = '[' + host + ']'
        authority = host + (':' + str(parsed.port) if parsed.port is not None else '')
        return urlunsplit((parsed.scheme, authority, parsed.path, '', ''))
    except (TypeError, ValueError):
        return 'about:blank'


def validate_input_event(event):
    """Bound each supported input before accessing a browser or issuing commands."""
    def invalid():
        return BridgeAuthError('PLATFORM_INPUT_INVALID', 400)

    fields = {
        'click': {'x', 'y', 'button'},
        'move': {'x', 'y', 'button', 'buttons'},
        'mousemove': {'x', 'y', 'button', 'buttons'},
        'mousedown': {'x', 'y', 'button', 'buttons'},
        'mouseup': {'x', 'y', 'button', 'buttons'},
        'scroll': {'x', 'y', 'deltaX', 'deltaY', 'delta_x', 'delta_y'},
        'wheel': {'x', 'y', 'deltaX', 'deltaY', 'delta_x', 'delta_y'},
        'text': {'text'}, 'insertText': {'text'}, 'type': {'text'},
        'key': {'key'}, 'keydown': {'key', 'code', 'modifiers'},
        'keyup': {'key', 'code', 'modifiers'},
        'tab': {'tabId', 'tab_id'}, 'tab_switch': {'tabId', 'tab_id'},
        'navigate': {'url'}, 'home': set(), 'reload': set(),
    }
    if not isinstance(event, dict) or not isinstance(event.get('type'), str):
        raise invalid()
    kind = event['type']
    if kind not in fields or set(event) - fields[kind] - {'type'}:
        raise invalid()
    if kind in {'click', 'move', 'mousemove', 'mousedown', 'mouseup'} and not {'x', 'y'} <= set(event):
        raise invalid()
    if ('x' in event) != ('y' in event):
        raise invalid()
    for name, limit in (('x', 1280), ('y', 800), ('deltaX', 10000), ('deltaY', 10000), ('delta_x', 10000), ('delta_y', 10000)):
        if name in event:
            value = event[name]
            if type(value) not in {int, float} or abs(value) > limit or not math.isfinite(value) or (name in {'x', 'y'} and value < 0):
                raise invalid()
    for name, limit in (('text', 16384), ('key', 128), ('code', 128), ('tabId', 128), ('tab_id', 128), ('url', 4096)):
        if name in event and (not isinstance(event[name], str) or not 1 <= len(event[name]) <= limit):
            raise invalid()
    required = 'text' if kind in {'text', 'insertText', 'type'} else 'key' if kind in {'key', 'keydown', 'keyup'} else 'url' if kind == 'navigate' else None
    if required and required not in event:
        raise invalid()
    if kind in {'tab', 'tab_switch'} and (('tabId' in event) + ('tab_id' in event) != 1):
        raise invalid()
    if 'button' in event and (not isinstance(event['button'], str) or event['button'] not in {'left', 'middle', 'right'}):
        raise invalid()
    for name, maximum in (('buttons', 31), ('modifiers', 15)):
        if name in event and (type(event[name]) is not int or not 0 <= event[name] <= maximum):
            raise invalid()


class PlatformBrowserRuntime:
    def __init__(self, root: Path):
        self.root = root
        self.instances = {}
        self.playwright = None

    async def probe(self):
        if self.playwright is None:
            try:
                from playwright.async_api import async_playwright
                self.playwright = await async_playwright().start()
            except (ImportError, OSError):
                return False
        return self.ready()

    def ready(self):
        executable = os.environ.get('WANX_PLATFORM_BROWSER_EXECUTABLE')
        if executable:
            return Path(executable).is_file() and os.access(executable, os.X_OK)
        if self.playwright:
            return Path(self.playwright.chromium.executable_path).is_file()
        return False

    async def open(self, key, state=None):
        if key in self.instances:
            return
        from playwright.async_api import async_playwright
        if self.playwright is None:
            self.playwright = await async_playwright().start()
        directory = self.root / key / secrets.token_hex(12)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        executable = os.environ.get('WANX_PLATFORM_BROWSER_EXECUTABLE', self.playwright.chromium.executable_path)
        if not Path(executable).is_file():
            raise BridgeAuthError('PLATFORM_RUNTIME_MISSING', 503)
        context = None
        try:
            context = await self.playwright.chromium.launch_persistent_context(
                str(directory), executable_path=executable, headless=True,
                args=['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
                viewport=dict(width=1280, height=800), timeout=30000,
            )
            lines = (directory / 'DevToolsActivePort').read_text().splitlines()
            endpoint = f'ws://127.0.0.1:{int(lines[0])}{lines[1]}'
            self.instances[key] = dict(context=context, endpoint=endpoint, selected=None, directory=directory, tabs={})
            if state is not None:
                await context.clear_cookies()
                await context.add_cookies(state['cookies'])
                for origin in state['origins']:
                    page = await context.new_page()
                    await page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<html></html>'))
                    await page.goto(origin['origin'], timeout=15000)
                    await page.evaluate('(items) => {localStorage.clear(); for (const i of items) localStorage.setItem(i.name,i.value)}', origin['localStorage'])
                    await page.close()
            if not context.pages:
                await context.new_page()
            await context.pages[0].set_viewport_size(dict(width=1280, height=800))
            if state is not None and all(p.url == 'about:blank' for p in context.pages):
                await context.pages[0].goto('https://channels.weixin.qq.com/', wait_until='domcontentloaded', timeout=30000)
        except Exception as exc:
            self.instances.pop(key, None)
            if context:
                await context.close()
            shutil.rmtree(directory, ignore_errors=True)
            if isinstance(exc, BridgeAuthError):
                raise
            raise BridgeAuthError('PLATFORM_RUNTIME_START_FAILED', 503) from exc

    def endpoint(self, key):
        return self.instances[key]['endpoint']

    def page(self, key):
        instance = self.instances[key]
        pages = instance['context'].pages
        selected = instance['selected']
        return selected if selected in pages else pages[-1]

    async def tabs(self, key):
        instance = self.instances[key]
        for page in instance['context'].pages:
            instance['tabs'].setdefault(page, secrets.token_urlsafe(12))
        return [dict(id=instance['tabs'][p], title=await p.title(), url=public_tab_url(p.url), active=p == self.page(key))
                for p in instance['context'].pages]

    async def frame(self, key):
        data = await self.page(key).screenshot(type='jpeg', quality=70, timeout=10000)
        if len(data) > 2 * 1024 * 1024:
            raise BridgeAuthError('PLATFORM_FRAME_TOO_LARGE', 502)
        return 'data:image/jpeg;base64,' + base64.b64encode(data).decode()

    async def input(self, key, event):
        validate_input_event(event)
        page = self.page(key)
        kind = event.get('type')
        if kind == 'click':
            await page.mouse.click(float(event['x']), float(event['y']), button=event.get('button', 'left'))
        elif kind in {'move', 'mousemove'}:
            await page.mouse.move(float(event['x']), float(event['y']))
        elif kind in {'scroll', 'wheel'}:
            if 'x' in event and 'y' in event:
                await page.mouse.move(float(event['x']), float(event['y']))
            await page.mouse.wheel(float(event.get('deltaX', event.get('delta_x', 0))), float(event.get('deltaY', event.get('delta_y', 0))))
        elif kind in {'text', 'insertText', 'type'}:
            await page.keyboard.insert_text(event['text'])
        elif kind == 'key':
            await page.keyboard.press(event['key'])
        elif kind in {'mousedown', 'mouseup'}:
            await page.mouse.move(float(event['x']), float(event['y']))
            method = page.mouse.down if kind == 'mousedown' else page.mouse.up
            await method(button=event.get('button', 'left'))
        elif kind in {'keydown', 'keyup'}:
            method = page.keyboard.down if kind == 'keydown' else page.keyboard.up
            modifiers = event.get('modifiers', 0)
            if type(modifiers) is not int or not 0 <= modifiers <= 15:
                raise BridgeAuthError('PLATFORM_INPUT_INVALID', 400)
            # CDP modifier bitmask: Alt=1, Control=2, Meta=4, Shift=8.
            for bit, modifier in ((1, 'Alt'), (2, 'Control'), (4, 'Meta'), (8, 'Shift')):
                await (page.keyboard.down(modifier) if modifiers & bit else page.keyboard.up(modifier))
            await method(event['key'])
            if kind == 'keyup':
                for modifier in ('Alt', 'Control', 'Meta', 'Shift'):
                    await page.keyboard.up(modifier)
        elif kind == 'reload':
            await page.reload(timeout=15000)
        elif kind in {'tab', 'tab_switch'}:
            target = next((p for p, identity in self.instances[key]['tabs'].items() if identity == event.get('tabId', event.get('tab_id')) and not p.is_closed()), None)
            if target is None:
                raise BridgeAuthError('PLATFORM_TAB_INVALID', 400)
            self.instances[key]['selected'] = target
        elif kind in {'navigate', 'home'}:
            url = 'https://channels.weixin.qq.com/' if kind == 'home' else event['url']
            target = urlsplit(url)
            if target.scheme != 'https' or target.hostname not in {'channels.weixin.qq.com', 'mp.weixin.qq.com'}:
                raise BridgeAuthError('PLATFORM_NAVIGATION_FORBIDDEN', 403)
            await page.goto(url, timeout=15000)
        else:
            raise BridgeAuthError('PLATFORM_INPUT_INVALID', 400)

    async def storage(self, key):
        return await self.instances[key]['context'].storage_state()

    async def close(self, key):
        instance = self.instances.get(key)
        if instance:
            await instance['context'].close()
            self.instances.pop(key, None)
            shutil.rmtree(instance["directory"], ignore_errors=True)

    async def shutdown(self):
        for key in list(self.instances):
            await self.close(key)
        if self.playwright:
            await self.playwright.stop()
            self.playwright = None

"""Diagnose static inline CSS rejected by the delivered HTML's own CSP.

This build check neither changes policies nor replaces Chromium enforcement.
It checks style elements/attributes in HTML, not styles created by JavaScript,
linked sheets, external policies, or general HTML/security validity.
"""
import base64
import hashlib
from html.parser import HTMLParser
import re


_SOURCE = re.compile(r"'(nonce|sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})'", re.I)
_SPACE = re.compile(r"[\t\n\f\r ]+")


def _policy(value):
    result = {}
    for part in value.split(';'):
        tokens = _SPACE.split(part.strip())
        if tokens[0]:
            # CSP ignores later occurrences of the same directive.
            result.setdefault(tokens[0].lower(), tokens[1:])
    return result


def _allows(policy, source, nonce, attribute):
    directive = 'style-src-attr' if attribute else 'style-src-elem'
    expressions = next((policy[key] for key in (directive, 'style-src', 'default-src')
                        if key in policy), None)
    if expressions is None:
        return True
    keywords = {value.lower() for value in expressions}
    special = [match.groups() for value in expressions if (match := _SOURCE.fullmatch(value))]
    if "'unsafe-inline'" in keywords and not special:
        return True
    for kind, value in special:
        kind = kind.lower()  # The source type is insensitive; its value is not.
        if kind == 'nonce':
            if not attribute and nonce and nonce == value:
                return True
        elif not attribute or "'unsafe-hashes'" in keywords:
            actual = base64.b64encode(hashlib.new(kind, source.encode('utf-8')).digest()).decode()
            if actual.rstrip('=') == value.replace('-', '+').replace('_', '/').rstrip('='):
                return True
    return False


class _Styles(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.policies = []
        self.head = True  # Includes an implicit head before body content.
        self.template_depth = 0
        self.text_tag = None
        self.style = None
        self.blocked = False

    def check(self, source, attrs, policies, attribute=False):
        if any(not _allows(policy, source, attrs.get('nonce'), attribute) for policy in policies):
            self.blocked = True

    def handle_starttag(self, tag, attributes):
        if self.text_tag:
            return
        if tag == 'template':
            self.template_depth += 1
        if self.template_depth:
            return
        if tag in {'script', 'textarea', 'title', 'noscript', 'xmp', 'iframe'}:
            self.text_tag = tag
        attrs = {}
        for key, value in attributes:
            attrs.setdefault(key, value or '')  # Browser uses the first attribute.
        if tag not in {'html', 'head', 'base', 'link', 'meta', 'title', 'style', 'script', 'noscript'}:
            self.head = False
        if (tag == 'meta' and self.head
                and attrs.get('http-equiv', '').lower() == 'content-security-policy'
                and 'content' in attrs):
            self.policies.append(_policy(attrs['content']))
        if 'style' in attrs:
            self.check(attrs['style'], attrs, self.policies, attribute=True)
        if tag == 'style':
            self.style = (attrs, list(self.policies), [])

    def handle_endtag(self, tag):
        if self.text_tag:
            if tag == self.text_tag:
                self.text_tag = None
            return
        if tag == 'template' and self.template_depth:
            self.template_depth -= 1
            return
        if self.template_depth:
            return
        if tag in {'head', 'body', 'html'}:
            self.head = False
        if tag == 'style' and self.style is not None:
            attrs, policies, parts = self.style
            self.check(''.join(parts), attrs, policies)
            self.style = None

    def handle_data(self, data):
        if self.style is not None:
            self.style[2].append(data)
        elif self.head and not self.text_tag and not self.template_depth and data.strip('\t\n\f\r '):
            self.head = False

    def close(self):
        super().close()
        if self.style is not None:
            attrs, policies, parts = self.style
            # HTMLParser retains unfinished raw-text CDATA until its end tag;
            # Chromium still checks an EOF-terminated style element.
            self.check(''.join(parts) + self.rawdata, attrs, policies)
            self.style = None


def inline_style_errors(source):
    parser = _Styles()
    # Match HTML input preprocessing before hashing style text/attributes.
    parser.feed(source.removeprefix('\ufeff').replace('\r\n', '\n').replace('\r', '\n').replace('\x00', '\ufffd'))
    parser.close()
    if parser.blocked:
        return [{'code': 'HOST_INLINE_STYLE_BLOCKED', 'path': '/app/host.html'}]
    return []

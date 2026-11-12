#!/usr/bin/env python3
"""Guest browser helper contract tests; no live Chrome needed."""
import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'server/box/vm-browser.py'


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('browser', PATH)
        cls.browser = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.browser)

    def test_structured_actions_use_fixed_cdp_methods_and_bounded_read(self):
        browser = self.browser

        class CDP:
            def __init__(self):
                self.calls = []

            def call(self, method, params=None):
                self.calls.append((method, params))
                if method == 'Runtime.evaluate':
                    return {'result': {'value': {'x': 10, 'y': 20, 'title': 'Guest', 'text': 'safe'}}}
                if method == 'Page.captureScreenshot':
                    return {'data': '/9j/2Q=='}
                return {}

        cdp = CDP()
        browser.perform(cdp, {'action': 'click', 'selector': '#button'}, 'tab1')
        self.assertEqual([c[0] for c in cdp.calls], ['Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'])
        self.assertIn('innerText', browser.READ_SCRIPT)
        self.assertIn('20000', browser.READ_SCRIPT)
        self.assertIn('100', browser.READ_SCRIPT)
        self.assertEqual(browser.perform(cdp, {'action': 'read'}, 'tab1')['tab_id'], 'tab1')
        shot = browser.perform(cdp, {'action': 'screenshot'}, 'tab1')
        self.assertEqual(shot['image'], '/9j/2Q==')
        self.assertEqual(shot['mime_type'], 'image/jpeg')

    def test_rejects_target_and_transport_overrides_before_connecting(self):
        for req in [
            {'action': 'read', 'screen': 'default'},
            {'action': 'navigate', 'url': 'file:///etc/passwd'},
            {'action': 'navigate', 'url': 'javascript:alert(1)'},
            {'action': 'evaluate', 'expression': '1'},
            {'action': 'read', 'tab_id': '../browser/secret'},
            {'action': 'click', 'selector': 'x' * 1001},
            {'action': 'fill', 'selector': 'input', 'text': 'x' * 16001},
        ]:
            with self.subTest(req=str(req)[:100]), self.assertRaises(ValueError):
                self.browser.validate(req)
        for screen in ['screen-103', 'default;touch nope', ':99', 99]:
            with self.assertRaises(ValueError):
                self.browser.port_for(screen)
        self.assertEqual(self.browser.port_for('screen-102'), 9302)
        self.assertEqual(self.browser.port_for('default'), 9299)


if __name__ == '__main__':
    unittest.main()

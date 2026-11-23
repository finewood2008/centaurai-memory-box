import { describe, expect, it } from 'vitest';
import { allowsWanxFrameNavigation } from '../src/main/wanx-frame-navigation.js';

describe('packaged Starlink frame navigation', () => {
  const document = 'file:///C:/client/local-ui/renderer/index.html';
  it('allows the panel and its scoped workbench', () => {
    expect(allowsWanxFrameNavigation(document, 'file:///C:/client/local-ui/starlink/ui/index.html', false)).toBe(true);
    expect(allowsWanxFrameNavigation(document, 'file:///C:/client/local-ui/starlink/ui/workbench/index.html?embedded=1&native=1', false)).toBe(true);
  });
  it('rejects top-level navigation, other files and remote documents', () => {
    expect(allowsWanxFrameNavigation(document, document, true)).toBe(false);
    for (const target of ['file:///C:/secrets.html', 'https://example.com/index.html', 'file:///C:/client/local-ui/starlink/ui/other.html']) {
      expect(allowsWanxFrameNavigation(document, target, false)).toBe(false);
    }
  });
});

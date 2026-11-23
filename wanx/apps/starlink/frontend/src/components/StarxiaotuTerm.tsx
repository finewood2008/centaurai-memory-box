import { getStarlinkTerm } from '../../../shared/starlink-glossary.mjs';
import { embeddedHost } from '../nativeHost';

export default function StarxiaotuTerm({ name }: { name: string }) {
  const term = getStarlinkTerm(name);
  if (!term || !embeddedHost()) return null;
  return <button type="button" className="starxiaotu-term" data-starxiaotu-term={term.key}
    aria-label={'向星小图了解' + term.label} aria-description={term.definition}
    title={term.label + '：' + term.definition}>✦</button>;
}

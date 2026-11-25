import { guideMark } from '../../../shared/application-guide.mjs';
import { getStarlinkTerm } from '../../../shared/starlink-glossary.mjs';
import { embeddedHost } from '../nativeHost';

export default function StarxiaotuTerm({ name }: { name: string }) {
  const term = getStarlinkTerm(name);
  if (!term || !embeddedHost()) return null;
  return <button type="button" className="starxiaotu-term" data-starxiaotu-term={term.key}
    aria-label={'让 CentaurAI 解释' + term.label} aria-description={term.definition}
    title={'让 CentaurAI 解释'+term.label}>{guideMark}</button>;
}

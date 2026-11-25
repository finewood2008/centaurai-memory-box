export interface GuideConcept {key: string; label: string; definition: string; page: string; view?: string}
export const concepts: Map<string,GuideConcept>;
export function isGuideBackgroundClick(event: MouseEvent): boolean;
export const guideMark: string;
export function guideScreenTargets(root: Document | HTMLElement, query:string): Array<{key:string;title:string;source:string;open:()=>boolean}>;

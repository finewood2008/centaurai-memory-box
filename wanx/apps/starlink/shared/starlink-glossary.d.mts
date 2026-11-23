export type StarlinkTerm = {
  key: string;
  label: string;
  guide: string;
  definition: string;
};

export const starlinkGlossary: { title: string; terms: StarlinkTerm[] }[];
export function getStarlinkTerm(key: string): StarlinkTerm | undefined;

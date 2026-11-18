export type ValidationIssue = {item_id: string; code: string; message: string; severity: 'error' | 'warning' | 'info'; reviewed?: boolean; property_name?: string};
export type IssueCategory = 'error' | 'warning' | 'reviewed' | 'info';
export type IssueGroup = {itemId: string; issues: ValidationIssue[]; count: number};
export function issueCategory(issue: ValidationIssue): IssueCategory;
export function groupPublicationIssues(issues?: ValidationIssue[]): Record<IssueCategory, IssueGroup[]>;
export function publicationIssueAdvice(issue: ValidationIssue): string | null;

import {identityKey} from '../shared/onboarding-contract.mjs';

export const ruleReviewKey=(identity,warehouseId,proposalId)=>'starlink.rule-review.v1.'+identityKey(identity)+'.'+warehouseId+'.'+proposalId;
export const questionList=value=>Array.isArray(value)?value.filter(q=>typeof q==='string'&&q.trim()).slice(0,2).map(q=>q.slice(0,300)):[];
// Display-only notes. Authorization and publication always come from server receipts.
export function savedReviewQuestions(storage,identity,warehouseId,proposalId) {
  try{return questionList(JSON.parse(storage.getItem(ruleReviewKey(identity,warehouseId,proposalId))||'{}').questions);}
  catch{return [];}
}
// Current context supersedes historical publication notes, including an explicit empty list.
export function unresolvedQuestions(context,proposal,publication,fallback=[]) {
  if(Array.isArray(context?.unresolved_questions))return questionList(context.unresolved_questions);
  if(Array.isArray(proposal?.unresolved_questions))return questionList(proposal.unresolved_questions);
  if(proposal?.status==='succeeded'&&proposal.valid===true)
    return questionList(proposal.result?.questions);
  return questionList(publication?.unresolved_questions ?? publication?.questions ?? fallback);
}

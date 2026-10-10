import { parseIssueReference, requestOpenIssue } from "../../inbox/model/issueReference";

export function IssueReferenceText({ text }: { text: string }) {
  const reference = parseIssueReference(text);
  if (!reference) return <>{text}</>;
  return (
    <>
      <button
        type="button"
        title={`Open MC-${reference.number} in the issue tracker`}
        onClick={(event) => {
          event.stopPropagation();
          requestOpenIssue(reference.number);
        }}
        className="rounded text-accent hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        #MC-{reference.number}
      </button>
      {reference.rest}
    </>
  );
}

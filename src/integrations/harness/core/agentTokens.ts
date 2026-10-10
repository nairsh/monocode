/** Sum per-request snapshots without counting repeated message updates twice. */
export class AgentTokens {
  private requests = new Map<string, Map<string, number>>();

  record(callId: string, requestId: string, tokens: number): number {
    const requests = this.requests.get(callId) ?? new Map<string, number>();
    requests.set(requestId, tokens);
    this.requests.set(callId, requests);
    return [...requests.values()].reduce((sum, count) => sum + count, 0);
  }

  clear(): void {
    this.requests.clear();
  }

  total(callId: string): number | undefined {
    const requests = this.requests.get(callId);
    return requests
      ? [...requests.values()].reduce((sum, count) => sum + count, 0)
      : undefined;
  }
}

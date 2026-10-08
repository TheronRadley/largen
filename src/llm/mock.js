/**
 * Deterministic fake LLM for tests and offline development.
 * Pass a `responder(request)` function to control the output.
 */
export class MockLLMProvider {
  constructor({ responder } = {}) {
    this.name = 'mock';
    this.responder = responder ?? (() => 'Mock answer.');
    this.calls = [];
  }

  async complete(request) {
    this.calls.push(request);
    const text = await this.responder(request);
    return { text: String(text ?? '') };
  }
}

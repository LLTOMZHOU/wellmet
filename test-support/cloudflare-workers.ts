// Stand-in for the Workers runtime module, so libraries that import it load under Node in tests.
export class WorkerEntrypoint<Env = unknown> {
  constructor(readonly ctx: unknown, readonly env: Env) {}
}
export const env = {};

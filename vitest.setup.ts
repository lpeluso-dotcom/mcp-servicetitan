// Mock implementation of WorkflowEntrypoint for testing
export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
  protected env: Env;
  constructor() {}
}

export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

export abstract class WorkflowStep {
  do<T>(
    name: string,
    callback: (ctx: any) => Promise<T>,
    rollbackOptions?: any,
  ): Promise<T>;
  do<T>(
    name: string,
    config: any,
    callback: (ctx: any) => Promise<T>,
    rollbackOptions?: any,
  ): Promise<T>;
  async do<T>(nameOrConfig: string, configOrCallback?: any, callbackOrRollback?: any): Promise<T> {
    const callback =
      typeof configOrCallback === 'function' ? configOrCallback : callbackOrRollback;
    return callback({ step: { name: '', count: 0 }, attempt: 0, config: {} });
  }
  sleep = async (name: string, duration: any) => {};
  sleepUntil = async (name: string, timestamp: any) => {};
  waitForEvent = async <T,>(name: string, options: any): Promise<any> => ({});
}

// Provide a global mock so the tests can use it
globalThis.WorkflowEntrypoint = WorkflowEntrypoint as any;
globalThis.WorkflowStep = WorkflowStep as any;
globalThis.WorkflowEvent = undefined as any;

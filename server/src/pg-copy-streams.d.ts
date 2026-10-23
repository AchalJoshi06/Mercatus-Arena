declare module "pg-copy-streams" {
  import { Writable } from "node:stream";
  export function from(sql: string, options?: Record<string, unknown>): Writable;
  const _default: { from: typeof from };
  export default _default;
}

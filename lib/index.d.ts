import type { Context } from '@deepseek-ai/cordis';
/** Required services: the route registry, the workspace registry (security gate), and the session store. */
export declare const inject: string[];
export declare function apply(ctx: Context): void;

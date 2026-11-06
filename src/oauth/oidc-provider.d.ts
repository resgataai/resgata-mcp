// O `oidc-provider` 9 não publica tipos: só o que este serviço usa, conferido no código da 9.13.3.
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export type Payload = Record<string, unknown>;

  export interface Interaction {
    uid: string;
    exp: number;
    returnTo: string;
    params: Record<string, string | undefined>;
    prompt: { name: string; reasons: string[]; details: Record<string, unknown> };
    result?: Record<string, unknown>;
    save(ttl: number): Promise<string>;
  }

  export interface Grant {
    addOIDCScope(scope: string): void;
    rejectOIDCScope(scope: string): void;
    addResourceScope(resource: string, scope: string): void;
    rejectResourceScope(resource: string, scope: string): void;
    save(ttl?: number): Promise<string>;
  }

  export interface KoaContext {
    path: string;
    method: string;
    querystring: string;
    oidc?: { route?: string };
  }

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    static readonly ctx: KoaContext | undefined;
    proxy: boolean;
    readonly Interaction: { find(uid: string): Promise<Interaction | undefined> };
    readonly Grant: new (o: {
      accountId: string;
      clientId: string;
    }) => Grant;
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    use(middleware: (ctx: KoaContext, next: () => Promise<void>) => Promise<void>): void;
    on(evento: string, ouvinte: (...args: unknown[]) => void): this;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<Interaction>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
      opcoes?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
  }

  export const errors: {
    InvalidGrant: new (descricao?: string) => Error;
    InvalidTarget: new (descricao?: string) => Error;
  };
}

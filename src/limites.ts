// shortcut: limite por pod (2 réplicas = até 2×); trocar pelo RateLimitStore da V2 no inc. 3

/** Contador por chave em janela fixa. */
export class LimiteJanela {
  readonly #contagens = new Map<string, { inicio: number; n: number }>();
  #ultimaLimpeza = 0;

  constructor(
    readonly maximo: number,
    readonly janelaMs: number,
    readonly agora: () => number = Date.now,
  ) {}

  /** Conta uma ocorrência; `ok=false` quando passou do máximo na janela corrente. */
  consumir(chave: string): { ok: boolean; reiniciaEmMs: number } {
    const t = this.agora();
    this.#limpar(t);
    let c = this.#contagens.get(chave);
    if (!c || t - c.inicio >= this.janelaMs) {
      c = { inicio: t, n: 0 };
      this.#contagens.set(chave, c);
    }
    c.n += 1;
    return { ok: c.n <= this.maximo, reiniciaEmMs: c.inicio + this.janelaMs - t };
  }

  #limpar(t: number): void {
    if (t - this.#ultimaLimpeza < this.janelaMs) return;
    this.#ultimaLimpeza = t;
    for (const [k, c] of this.#contagens) if (t - c.inicio >= this.janelaMs) this.#contagens.delete(k);
  }
}

/** Semáforo sem fila: quem não consegue vaga recebe `null` e devolve erro `ocupado` com `tentar_novamente`. */
export class Semaforo {
  #emUso = 0;

  constructor(readonly vagas: number) {}

  tentar(): (() => void) | null {
    if (this.#emUso >= this.vagas) return null;
    this.#emUso += 1;
    let liberado = false;
    return () => {
      if (liberado) return;
      liberado = true;
      this.#emUso -= 1;
    };
  }

  get emUso(): number {
    return this.#emUso;
  }
}

/** Operações analíticas pesadas da V2: no máximo 4 simultâneas por pod. */
export const OPERACOES_ANALITICAS: ReadonlySet<string> = new Set([
  'selfContractingCustomersSearch',
  'conversionOverview',
  'dashboard_1',
  'channelEconomicsScreen',
  'disbursedOffers',
]);

export type Limites = {
  porGrant: LimiteJanela;
  efeitosPorUsuario: LimiteJanela;
  /** Rotas de navegador do OAuth (authorize, interação, callback do IdP). */
  oauthPorIp: LimiteJanela;
  /** `/oauth/token` e `/oauth/revoke`: chegam de servidores com IP compartilhado, então a chave é cliente + credencial. */
  oauthPorCredencial: LimiteJanela;
  analiticas: Semaforo;
};

/** Valores do DESENHO §10 (propostos, decisão do dono). */
export function criarLimites(agora: () => number = Date.now): Limites {
  return {
    porGrant: new LimiteJanela(60, 60_000, agora),
    efeitosPorUsuario: new LimiteJanela(20, 86_400_000, agora),
    oauthPorIp: new LimiteJanela(30, 60_000, agora),
    oauthPorCredencial: new LimiteJanela(10, 60_000, agora),
    analiticas: new Semaforo(4),
  };
}

import { type ClienteV2, ErroV2 } from './tipos.js';

/** Cliente que recusa tudo: só para testes do esqueleto, sem V2. */
export function clienteV2Pendente(): ClienteV2 {
  return {
    chamar: async () => {
      throw new ErroV2('erro_interno', 'cliente da V2 em construção');
    },
    escoposEfetivos: async () => {
      throw new ErroV2('tentar_novamente', 'cliente da V2 em construção');
    },
  };
}

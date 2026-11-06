import { type ClienteV2, ErroV2 } from './tipos.js';

/** Lugar do cliente da V2 até o P4 entrar. */
export function clienteV2Pendente(): ClienteV2 {
  return {
    chamar: async () => {
      throw new ErroV2('erro_interno', 'cliente da V2 em construção');
    },
  };
}

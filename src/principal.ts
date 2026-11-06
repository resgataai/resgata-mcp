import { carregarConfig, ErroDeConfiguracao } from './config.js';
import { iniciar } from './iniciar.js';

try {
  const instancia = await iniciar(carregarConfig());
  const parar = () => {
    instancia.log.info('servidor.parando');
    instancia.fechar().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', parar);
  process.once('SIGINT', parar);
} catch (e) {
  // Só a mensagem: as de configuração citam nomes de variáveis, nunca valores.
  console.error(e instanceof ErroDeConfiguracao ? e.message : `falha ao subir: ${(e as Error).name}`);
  process.exit(1);
}

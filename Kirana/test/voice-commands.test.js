/**
 * Comandos locais de voz (v0.4.4) — o vocabulário do barge-in.
 *
 * Estes testes são puros (sem DOM, sem microfone): provam o que é e o que NÃO é
 * comando de interrupção. O caminho completo (microfone → estado → áudio
 * cancelado) está em `test/voice-bargein.test.js`; o áudio real, no Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distance,
  isEchoOf,
  isStopCommand,
  isStopToken,
  isWakeToken,
  normalizeSpeech,
  orderIn,
  words,
} from '../public/voice-commands.js';

/* ---------------------------- normalização -------------------------------- */

test('normaliza acento, caixa e pontuação', () => {
  assert.equal(normalizeSpeech('  Kirana, SILÊNCIO!  '), 'kirana silencio');
  assert.equal(normalizeSpeech('Pode parar… por favor?'), 'pode parar por favor');
  assert.equal(normalizeSpeech('Stop, Kirana!'), 'stop kirana');
  assert.deepEqual(words('Kirana, pare'), ['kirana', 'pare']);
});

test('distância de edição serve para erro de transcrição', () => {
  assert.equal(distance('kirana', 'kirana'), 0);
  assert.equal(distance('kirana', 'quirana'), 2); // k→q e a vogal a mais
  assert.equal(distance('kirana', 'quero'), 6);
});

/* ------------------------- palavra de ativação ---------------------------- */

test('reconhece a palavra de ativação e suas variações fonéticas', () => {
  for (const token of ['kirana', 'quirana', 'kiranna', 'quiranna', 'kyrana', 'carina', 'kirona', 'irana']) {
    assert.equal(isWakeToken(token), true, token);
  }
});

test('não confunde palavras comuns com a palavra de ativação', () => {
  for (const token of ['quero', 'para', 'kits', 'caro', 'kilo', 'kir']) {
    assert.equal(isWakeToken(token), false, token);
  }
});

test('reconhece as ordens de parada fortes', () => {
  for (const token of ['pare', 'parar', 'silencio', 'stop', 'quieta', 'cala', 'chega', 'basta', 'pause']) {
    assert.equal(isStopToken(token), true, token);
  }
});

/* ---------------------- comandos COM palavra de ativação ------------------ */

test('as variações pedidas pelo usuário são reconhecidas', () => {
  const variacoes = [
    'Kirana, pare',
    'Quirana, pare',
    'Kirana, para',
    'Pare de falar',
    'Pode parar, Kirana',
    'Kirana, silêncio',
    'Stop, Kirana',
    'KIRANA PARE!',
    'kirana pare agora por favor',
    'Kirana, pode parar tudo',
    'Kirana, para de falar',
  ];
  for (const fala of variacoes) {
    const resultado = isStopCommand(fala);
    assert.equal(resultado.matched, true, `não reconheceu: ${fala}`);
    assert.ok(['wake', 'phrase'].includes(resultado.kind), fala);
  }
});

test('com a palavra de ativação, o comando vale mesmo no meio de uma frase', () => {
  const resultado = isStopCommand('espera, kirana, para um pouco que eu quero perguntar outra coisa');
  assert.equal(resultado.matched, true);
  assert.equal(resultado.kind, 'wake');
});

test('com a palavra de ativação, o comando não exige janela de fala', () => {
  // "Kirana, pare" dito quando ela já terminou continua sendo ordem, não pergunta.
  assert.equal(isStopCommand('Kirana, pare').requiresWindow, false);
});

test('palavra de ativação SEM ordem não é comando', () => {
  for (const fala of ['Kirana, tudo bem?', 'Kirana, me explique os serviços', 'oi kirana']) {
    assert.equal(isStopCommand(fala).matched, false, fala);
  }
});

/* -------------------- comandos SEM palavra de ativação -------------------- */

test('ordens curtas e ancoradas valem quando ela está falando', () => {
  const ordens = ['pare', 'para', 'pare de falar', 'para de falar', 'pode parar', 'silêncio', 'stop', 'chega', 'cala a boca'];
  for (const fala of ordens) {
    const resultado = isStopCommand(fala);
    assert.equal(resultado.matched, true, `não reconheceu: ${fala}`);
    assert.equal(resultado.requiresWindow, true, `${fala} deveria exigir janela de fala`);
  }
});

test('sem "Kirana", ordens só valem durante a fala (não engolem a pergunta do usuário)', () => {
  // Quem decide é o controlador com `requiresWindow`; aqui o contrato é esse.
  assert.equal(isStopCommand('silêncio').requiresWindow, true);
  assert.equal(isStopCommand('Kirana, silêncio').requiresWindow, false);
});

/* --------------------------- falsos positivos ----------------------------- */

test('perguntas comuns não interrompem a fala', () => {
  const perguntas = [
    'por que o WhatsApp para de funcionar?',
    'quando você pode parar de falar?',
    'para onde vai o projeto PRJ-001?',
    'o atendimento para quando o cliente reclama',
    'qual o prazo para começar?',
    'como faço para parar de receber mensagens?',
  ];
  for (const fala of perguntas) {
    assert.equal(isStopCommand(fala).matched, false, `falso positivo: ${fala}`);
  }
});

test('"para" no meio de uma frase não é ordem', () => {
  assert.equal(isStopCommand('eu vou para o escritório').matched, false);
  assert.equal(isStopCommand('a proposta para o cliente está pronta').matched, false);
  // mas no fim da frase é: "Kirana, para"
  assert.equal(isStopCommand('kirana para').matched, true);
});

test('negação não interrompe: "não pare" é o contrário de parar', () => {
  assert.equal(isStopCommand('não pare').matched, false);
  assert.equal(isStopCommand('nao pare de falar').matched, false);
  assert.equal(isStopCommand('nunca pare').matched, false);
});

test('frases longas não são comandos, mesmo com a palavra "pare"', () => {
  const fala = 'eu queria saber se o serviço de atendimento digital para pequenas empresas inclui integração com o whatsapp e com o crm';
  assert.equal(isStopCommand(fala).matched, false);
  assert.equal(isStopCommand('').matched, false);
  assert.equal(isStopCommand('   ').matched, false);
});

test('fala normal do dia a dia não é comando', () => {
  for (const fala of ['quero saber sobre os planos', 'me fale sobre o CRM', 'quais serviços vocês têm', 'bom dia']) {
    assert.equal(isStopCommand(fala).matched, false, fala);
  }
});

/* --------------------- palavra de ativação mal reconhecida ---------------- */

test('ordem no fim de uma fala curta vence a palavra de ativação mal transcrita', () => {
  // "Kimara"/"Kirara" são saídas reais do reconhecedor para "Kirana".
  for (const fala of ['Kimara, pare', 'Mariana, pare', 'por favor pare']) {
    assert.equal(isStopCommand(fala).matched, true, fala);
  }
  // Quando a palavra de ativação é irreconhecível ("Mariana"), a ordem só vale
  // dentro da janela de fala — não pode engolir uma frase do usuário.
  assert.equal(isStopCommand('Mariana, pare').requiresWindow, true);
  // "Kirara"/"Quirana" o reconhecedor acerta perto o bastante da palavra de
  // ativação: já entram pelo caminho normal (e por isso não exigem janela).
  assert.equal(isStopCommand('Kirara, pare').matched, true);
  assert.equal(isStopCommand('Kirara, pare').kind, 'wake');
});

test('a regra do fim da frase não vale para fala longa', () => {
  assert.equal(isStopCommand('eu estava falando com a equipe toda sobre isso e pedi para parar').matched, false);
});

/* ------------------------------- interino --------------------------------- */

test('resultado interino também identifica o comando (com o motivo marcado)', () => {
  const resultado = isStopCommand('Kirana, pare', { interim: true });
  assert.equal(resultado.matched, true);
  assert.equal(resultado.reason, 'wake_interim');
  assert.equal(isStopCommand('pare', { interim: true }).reason, 'phrase_interim');
});

/* --------------------------------- eco ----------------------------------- */

test('a própria fala da Kirana é reconhecida como eco', () => {
  const falado = 'A Opportunity AI tem seis frentes de trabalho, incluindo atendimento digital e agentes personalizados';
  assert.equal(isEchoOf('atendimento digital e agentes personalizados', falado), true);
  assert.equal(isEchoOf('seis frentes de trabalho', falado), true);
});

test('fala do usuário não é confundida com eco', () => {
  const falado = 'A Opportunity AI tem seis frentes de trabalho';
  assert.equal(isEchoOf('quero saber o preço do plano', falado), false);
  assert.equal(isEchoOf('pare', falado), false); // ordem curta não está na fala dela
  assert.equal(isEchoOf('qualquer coisa', ''), false); // nada foi falado
});

test('comando de uma palavra é eco só se ela estiver dizendo essa palavra', () => {
  const falado = 'Se preferir, eu posso parar e esperar você.';
  assert.equal(isEchoOf('parar', falado), true); // a própria voz voltando
  assert.equal(isEchoOf('pare', falado), false); // "pare" não está na fala dela
});

/* -------------------------- ordem dentro da frase ------------------------- */

test('orderIn devolve a palavra que caracteriza a ordem', () => {
  assert.equal(orderIn(['pare']), 'pare');
  assert.equal(orderIn(['para']), 'para');
  assert.equal(orderIn(['pare', 'de', 'falar']), 'pare');
  assert.equal(orderIn(['pode', 'parar']), 'parar');
  assert.equal(orderIn(['cala', 'a', 'boca']), 'cala');
  assert.equal(orderIn(['serviços']), null);
});

// Guarda de segredos: procura, no que passa pelas conversas do MyCo (o que você escreve, os comandos
// que o funcionário roda e o que eles devolvem), coisas com cara de segredo. Não bloqueia nada: avisa
// na caixa "precisa de mim" para você trocar a senha/token e não colar de novo. O segredo em si nunca
// é guardado nem mostrado, só o tipo e onde apareceu.

export interface SecretFinding {
  /** Tipo, em português: "uma senha", "uma chave da API da Anthropic"… */
  label: string;
}

const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'uma chave privada', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { label: 'uma chave da API da Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'uma chave da OpenAI', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { label: 'um token do GitHub', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { label: 'uma chave da AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'um token do Slack', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
  { label: 'uma chave do Stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { label: 'uma chave do Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Senha na linha de comando: mysql -pSEGREDO, --password=SEGREDO, PASSWORD=SEGREDO (não placeholders).
  { label: 'uma senha', re: /\b(?:mysql|mariadb|mysqldump)\b[^\n]*\s-p(?!\s)(?![$<{%])[^\s'"]{4,}/i },
  { label: 'uma senha', re: /--password[= ](?![$<{%])['"]?[^\s'"$<{%]{4,}/i },
  { label: 'uma senha', re: /\b(?:DB_PASS(?:WORD)?|MYSQL_(?:ROOT_)?PASSWORD|POSTGRES_PASSWORD|PASSWORD|PASSWD|PGPASSWORD)\s*[=:]\s*['"]?(?![$<{%*])[^\s'"$<{%*]{6,}/ },
  // Conexão com usuário e senha na URL: postgres://user:senha@host
  { label: 'uma senha numa URL de conexão', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?![$<{%*])[^\s:@/]{4,}@[^\s/]+/i },
];

/** O primeiro segredo encontrado no texto, ou null. */
export function findSecret(text: string): SecretFinding | null {
  if (!text || text.length < 8) return null;
  for (const p of PATTERNS) if (p.re.test(text)) return { label: p.label };
  return null;
}

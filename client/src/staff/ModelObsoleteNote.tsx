import type { Engine, StaffProfile } from '../../../shared/model';
import { t } from '../i18n';
import { engineName } from './fallbackEngine';

type Obsolete = NonNullable<StaffProfile['modelObsolete']>;

/** O texto do aviso (o mesmo no painel, na ficha e no selo do cartão): o motor recusou o modelo, a conversa segue no padrão. */
export const modelObsoleteText = (o: Obsolete): string => t('staff.modelObsolete', { model: o.model, engine: t(engineName(o.engine)) });

/**
 * A marca do servidor só vale enquanto o modelo e o motor da ficha são os que ele recusou. No formulário, trocar o modelo
 * (ou o motor) antes de salvar já resolve: o aviso some na hora, em vez de esperar o servidor reler a ficha.
 */
export const obsoleteFor = (staff: Pick<StaffProfile, 'modelObsolete'> | null | undefined, model: string | null, engine: Engine): Obsolete | null => {
  const o = staff?.modelObsolete;
  return o && o.model === model && o.engine === engine ? o : null;
};

export function ModelObsoleteNote({ obsolete }: { obsolete: Obsolete }) {
  return (
    <p className="model-obsolete small" role="note">
      <strong>{t('board.modelObsolete')}.</strong> {modelObsoleteText(obsolete)}
    </p>
  );
}

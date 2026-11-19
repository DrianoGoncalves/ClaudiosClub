import { createElement, type ComponentProps } from 'react';
import { SchedulesBoardCore } from '../../client/src/schedules/SchedulesBoard';

/** Só em teste: a tela de agendamentos já com dados e hora (o render no servidor não roda o efeito que lê do servidor). */
export const SchedulesBoardSeeded = (props: ComponentProps<typeof SchedulesBoardCore>) => createElement(SchedulesBoardCore, props);

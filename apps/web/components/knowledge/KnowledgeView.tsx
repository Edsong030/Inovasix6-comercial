'use client';

import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  IconBuilding,
  IconChevronRight,
  IconDocument,
  IconHelp,
  IconSparkles,
  IconTarget,
  type IconProps,
} from '@/components/ui/icons';
import { KNOWLEDGE_CARDS, type KnowledgeCard } from '@/lib/mock/data';
import styles from './Knowledge.module.css';

const ICONS: Record<KnowledgeCard['icon'], ComponentType<IconProps>> = {
  building: IconBuilding,
  target: IconTarget,
  help: IconHelp,
  document: IconDocument,
};

/** Knowledge base overview. Upload/edit are not wired — no RAG endpoints yet. */
export function KnowledgeView() {
  return (
    <>
      <div className={styles.banner}>
        <span className={styles.bannerIcon} aria-hidden="true">
          <IconSparkles size={17} />
        </span>
        <p className={styles.bannerText}>
          A base de conhecimento alimenta as respostas da IA. Nesta versão os conteúdos
          são ilustrativos — o upload de documentos e a indexação ainda não estão ativos.
        </p>
      </div>

      <div className={styles.grid}>
        {KNOWLEDGE_CARDS.map((item) => {
          const Icon = ICONS[item.icon];
          return (
            <Card key={item.id} interactive ariaLabel={item.title}>
              <div className={styles.card}>
                <span className={styles.icon} aria-hidden="true">
                  <Icon size={19} />
                </span>
                <h2 className={styles.title}>{item.title}</h2>
                <p className={styles.description}>{item.description}</p>
                <Badge tone="accent">{item.stat}</Badge>
                <div className={styles.foot}>
                  <span className={styles.updated}>{item.updatedAt}</span>
                  <Button variant="ghost" size="sm" aria-label={`Gerenciar ${item.title}`}>
                    Gerenciar
                    <IconChevronRight size={14} />
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';

const icons = {
  brand: '8360f', materials: '39476', materialsActive: 'dd984', ontology: 'c2e27', ontologyActive: '9d02a',
  releases: '59013', releasesActive: 'f96fe', graph: 'e3b60', search: '7df64', searchActive: 'b3a19',
  sensitive: '85ae1', sensitiveActive: 'f9f6f', skills: '1bd2e', settings: 'cfc5b', tasks: 'ab0a0', help: '15329',
  history: 'b9197', network: '6de6c', collapse: '2f799', find: '4abf2', plus: '874ec', file: '5047d',
  fileActive: '67b8b', more: '2f3ca', info: 'be178', saved: '94b92', publish: '0792b', copy: 'd938a',
  type: '3b5eb', compare: '478d3', down: 'a08f6', restore: '8155f', query: 'dab7f', edit: '44a99',
  right: '2a325', check: 'cf381', warning: '1942a', lock: '920c8', play: '6bdc7',
} as const;
export type IconName = keyof typeof icons;
export function DesignIcon({ name }: { name: IconName }) {
  return <img className="design-icon" src={`/assets/material-review/${icons[name]}.svg`} alt="" aria-hidden="true" />;
}

/** Native modal preserves focus and keyboard navigation without changing business actions. */
export function WorkbenchDrawer({ title, children, close, canClose = true, className = '', closeLabel='关闭', inline=false }: {
  title: string; children: ReactNode; close: () => void; canClose?: boolean; className?: string; closeLabel?:string; inline?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (inline) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, [inline]);
  const content = <>
    <header><h2>{title}</h2><button type="button" disabled={!canClose} onClick={close}>{closeLabel}</button></header>
    <div className="workbench-drawer-body">{children}</div>
  </>;
  if (inline) return <section className={`workbench-inline ${className}`} aria-label={title}>{content}</section>;
  return <dialog ref={ref} className={`workbench-drawer ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); if (canClose) close(); }}>
    {content}
  </dialog>;
}

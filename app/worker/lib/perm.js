// Permission matrix: role x module x action. This file is the single source of truth: the
// Felhasználók > Jogosultságok screen renders its matrix from MODULES (GET /api/meta), and every
// route checks the same keys with need(ctx, module, action).
//
// Actions: view, create, edit, delete, approve. A module only lists the actions that mean
// something for it, each with a description shown as the matrix column tooltip.

import { forbidden } from './http.js';

export const ACTIONS = {
  view: 'Megtekintés',
  create: 'Létrehozás',
  edit: 'Módosítás',
  delete: 'Törlés',
  approve: 'Jóváhagyás',
};

export const MODULES = [
  {
    key: 'inbound', name: 'Betárolás', group: 'warehouse',
    actions: {
      view: 'Betárolások megtekintése',
      create: 'Új betárolás, CSV import',
      edit: 'Áruátvétel és polcra helyezés',
      delete: 'Betárolás sztornózása',
      approve: 'Lezárás eltéréssel',
    },
  },
  {
    key: 'orders', name: 'Megrendelések', group: 'warehouse',
    actions: {
      view: 'Nyitott rendelések megtekintése',
      create: 'Új rendelés, CSV import',
      edit: 'Rendelés módosítása, felfüggesztése',
      delete: 'Rendelés sztornózása',
    },
  },
  {
    key: 'picking', name: 'Komissió', group: 'warehouse',
    actions: {
      view: 'Komissiós hullámok megtekintése',
      create: 'Hullám indítása',
      edit: 'Kiszedés és csomagolás, címke',
      delete: 'Hullám megszakítása',
      approve: 'Hullám lezárása hiánnyal',
    },
  },
  {
    key: 'counts', name: 'Leltár', group: 'warehouse',
    actions: {
      view: 'Leltárak megtekintése',
      create: 'Leltár indítása',
      edit: 'Számlálás rögzítése',
      delete: 'Leltár törlése',
      approve: 'Eltérések könyvelése',
    },
  },
  {
    key: 'stock', name: 'Készlet', group: 'warehouse',
    actions: {
      view: 'Készlet és cikktörzs megtekintése',
      create: 'Új cikk, CSV import',
      edit: 'Cikk módosítása, áttárolás',
      delete: 'Cikk inaktiválása',
      approve: 'Kézi készletkorrekció',
    },
  },
  {
    key: 'history', name: 'Rendeléstörténet', group: 'warehouse',
    actions: {
      view: 'Lezárt rendelések megtekintése, export',
      create: 'Visszáru rögzítése',
      edit: 'Kézbesítés és megjegyzés rögzítése',
    },
  },
  {
    key: 'transport', name: 'Fuvarszervezés', group: 'warehouse',
    actions: {
      view: 'Futárátvételek és fuvarok megtekintése',
      create: 'Fuvar és futárátvétel felvétele',
      edit: 'Fuvar módosítása, rendelések hozzárendelése',
      delete: 'Fuvar törlése',
      approve: 'Manifeszt lezárása (feladás)',
    },
  },
  {
    key: 'partners', name: 'Partnerek', group: 'commercial',
    actions: {
      view: 'Partnerek megtekintése',
      create: 'Új partner',
      edit: 'Alapadatok, kapcsolattartók, dokumentumok',
      delete: 'Partner törlése',
      approve: 'Tarifák és integrációk módosítása',
    },
  },
  {
    key: 'quotes', name: 'Ajánlatkészítő', group: 'commercial',
    actions: {
      view: 'Ajánlatok megtekintése',
      create: 'Új ajánlat',
      edit: 'Ajánlat módosítása',
      delete: 'Ajánlat törlése',
    },
  },
  {
    key: 'billing', name: 'Elszámolás', group: 'commercial',
    actions: {
      view: 'Elszámolások megtekintése',
      create: 'Elszámolás készítése, egyedi tétel rögzítése',
      edit: 'Tételek módosítása',
      delete: 'Piszkozat törlése',
      approve: 'Jóváhagyás és számla kiállítása',
    },
  },
  {
    key: 'settings', name: 'Beállítások', group: 'admin',
    actions: {
      view: 'Beállítások megtekintése',
      create: 'Raktárhely és méret felvétele',
      edit: 'Beállítások módosítása',
      delete: 'Raktárhely és méret törlése',
    },
  },
  {
    key: 'users', name: 'Felhasználók', group: 'admin',
    actions: {
      view: 'Felhasználók és szerepkörök megtekintése',
      create: 'Új felhasználó, új szerepkör',
      edit: 'Felhasználók és jogosultságok módosítása',
      delete: 'Felhasználó és szerepkör törlése',
    },
  },
];

const VALID = new Set(MODULES.flatMap((m) => Object.keys(m.actions).map((a) => `${m.key}:${a}`)));

export const isValidPermission = (module, action) => VALID.has(`${module}:${action}`);

// user: { is_admin, permissions: Set("module:action") }
export function can(user, module, action) {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.permissions.has(`${module}:${action}`);
}

// Throws 403 unless the session user may perform the action.
export function need(ctx, module, action) {
  if (!can(ctx.user, module, action)) {
    const m = MODULES.find((x) => x.key === module);
    const what = m && m.actions[action] ? `${m.name}: ${m.actions[action].toLowerCase()}` : `${module}:${action}`;
    throw forbidden(`Ehhez nincs jogosultságod (${what}).`);
  }
}

// Plain object for the browser: { orders: ["view", "create"], ... }
export function permissionMap(user) {
  const out = {};
  for (const m of MODULES) {
    out[m.key] = Object.keys(m.actions).filter((a) => can(user, m.key, a));
  }
  return out;
}

export const go = (path) => { window.location.hash = path; };

// Mirrors the server permission matrix. The server is the authority; this only hides buttons.
const PERMS = {
  owner: ['*'], admin: ['*'],
  project_manager: ['view', 'project.manage', 'baseline.edit', 'report.write', 'report.approve', 'request.create', 'request.approve', 'po.manage', 'finance.view', 'variation.request', 'revision.request', 'revision.approve', 'stock.view', 'doc.upload'],
  engineer: ['view', 'report.write', 'request.create', 'stock.view', 'doc.upload', 'variation.request'],
  storekeeper: ['view', 'request.create', 'delivery.confirm', 'stock.issue', 'stock.view', 'doc.upload'],
  accountant: ['view', 'finance.view', 'finance.write', 'po.manage', 'stock.view', 'doc.upload'],
  viewer: ['view', 'stock.view'],
};
export const can = (user, perm) => !!user && (PERMS[user.role]?.includes('*') || PERMS[user.role]?.includes(perm));
export const isGlobal = (user) => !!user && ['owner', 'admin'].includes(user.role);

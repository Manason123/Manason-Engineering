import { createContext, useContext } from 'react';

/**
 * Keys are the English strings themselves. t('Save') returns the translation when one exists,
 * otherwise the English text, so a missing translation never breaks the screen.
 * To add a language: add a dictionary below and an entry in LANGS.
 */
export const LANGS = [['en', 'English'], ['rw', 'Kinyarwanda'], ['fr', 'Français']];

const rw = {
  'Sign in': 'Injira', 'Sign out': 'Sohoka', Email: 'Imeri', Password: 'Ijambo ry\'ibanga', Language: 'Ururimi',
  Dashboard: 'Imbonerahamwe nyobozi', Projects: 'Imishinga', Project: 'Umushinga', Overview: 'Incamake', Baseline: 'Gahunda fatizo',
  'Daily reports': 'Raporo z\'umunsi', Materials: 'Ibikoresho', Finance: 'Imari', Schedule: 'Igihe cy\'imirimo', Variations: 'Impinduka ku ngengo y\'imari',
  Documents: 'Inyandiko', Audit: 'Igenzura', Users: 'Abakoresha', Settings: 'Igenamiterere', Reports: 'Raporo',
  Save: 'Bika', Cancel: 'Reka', Submit: 'Ohereza', Approve: 'Emeza', Reject: 'Anga', Add: 'Ongeraho', Delete: 'Siba', Create: 'Kora', Close: 'Funga', Refresh: 'Vugurura',
  Name: 'Izina', Code: 'Kode', Status: 'Uko bimeze', Date: 'Itariki', Amount: 'Amafaranga', Quantity: 'Umubare', Unit: 'Igipimo', Reason: 'Impamvu', Note: 'Icyitonderwa',
  'Contract value': 'Agaciro k\'amasezerano', 'Client': 'Umukiriya', Progress: 'Aho imirimo igeze', 'Planned end': 'Itariki yo kurangiza', 'Forecast end': 'Itariki iteganyijwe',
  'Original budget': 'Ingengo y\'imari y\'ibanze', 'Approved variations': 'Impinduka zemejwe', 'Revised budget': 'Ingengo y\'imari ivuguruye', 'Pending variations': 'Impinduka zitegereje kwemezwa',
  'Actual cost': 'Ikiguzi nyakuri', 'Committed cost': 'Ikiguzi cyasezeranywe', 'Forecast final cost': 'Ikiguzi cya nyuma giteganyijwe', 'Forecast profit': 'Inyungu iteganyijwe',
  'Forecast margin': 'Ijanisha ry\'inyungu riteganyijwe', 'Budget used': 'Ingengo y\'imari yakoreshejwe', 'Remaining budget': 'Ingengo y\'imari isigaye',
  'Cash received': 'Amafaranga yinjiye', 'Cash paid': 'Amafaranga yasohotse', 'Net cash': 'Amafaranga asigaye', Receivable: 'Amafaranga agomba kwishyurwa',
  Invoices: 'Fagitire', Bills: 'Fagitire z\'abatanga ibikoresho', 'Cash book': 'Igitabo cy\'amafaranga', Costs: 'Ibiciro', 'Cash flow': 'Imigendekere y\'amafaranga',
  actual: 'nyakuri', estimated: 'igereranyo', forecast: 'iteganyijwe', awaiting_approval: 'itegereje kwemezwa',
  'Active projects': 'Imishinga irimo gukorwa', 'Delayed projects': 'Imishinga yatinze', 'Over budget': 'Yarengeje ingengo y\'imari', 'Material shortages': 'Ibura ry\'ibikoresho',
  Alerts: 'Iburira', 'No alerts': 'Nta buburira buhari', Activities: 'Ibikorwa', Activity: 'Igikorwa', 'Planned qty': 'Umubare uteganyijwe', 'Done qty': 'Umubare wakozwe',
  'Import BOQ from Excel': 'Shyiramo BOQ ivuye muri Excel', 'Approve baseline': 'Emeza gahunda fatizo', 'New report': 'Raporo nshya', 'Report date': 'Itariki ya raporo',
  Weather: 'Ikirere', Delays: 'Gutinda', Problems: 'Ibibazo', Workers: 'Abakozi', Hours: 'Amasaha', Trade: 'Umwuga', Equipment: 'Ibikoresho by\'ubwubatsi', Labour: 'Abakozi b\'ubwubatsi',
  Consumed: 'Byakoreshejwe', Wasted: 'Byangiritse', Photos: 'Amafoto', Draft: 'Ikibanza', Submitted: 'Byoherejwe', Approved: 'Byemejwe', Rejected: 'Byanzwe',
  'Material requests': 'Gusaba ibikoresho', 'New request': 'Gusaba gushya', 'Needed date': 'Itariki bikenewe', Requested: 'Byasabwe', Purchased: 'Byaguzwe', Delivered: 'Byatanzwe', Received: 'Byakiriwe', Issued: 'Byahawe site',
  Inventory: 'Ububiko', 'Purchase orders': 'Ibyemezo byo kugura', Deliveries: 'Ibyatanzwe', Supplier: 'Utanga ibikoresho', 'Unit price': 'Igiciro ku gipimo', 'Delivery note': 'Inyemezabwishyu y\'itangwa',
  Store: 'Ububiko', Site: 'Ku site', Reserved: 'Byabikiwe', 'On order': 'Biteganyijwe kuza', Shortage: 'Ibura', Required: 'Bikenewe',
  'Confirm receipt': 'Emeza ko byakiriwe', 'Issue to site': 'Hereza ku site', 'Stock adjustment': 'Guhindura ububiko',
  'Record payment': 'Andika kwishyura', 'New invoice': 'Fagitire nshya', 'New bill': 'Fagitire nshya y\'utanga', 'New cost': 'Ikiguzi gishya', Reference: 'Nomero y\'ifatizo', 'Due date': 'Itariki yo kwishyura',
  'Awaiting approval': 'Itegereje kwemezwa', Reverse: 'Subiza inyuma', 'Delay (days)': 'Gutinda (iminsi)', 'Propose revised schedule': 'Tanga gahunda ivuguruye',
  'Management report': 'Raporo y\'ubuyobozi', Daily: 'Buri munsi', Weekly: 'Buri cyumweru', Monthly: 'Buri kwezi', 'Export Excel': 'Ohereza muri Excel', 'Export PDF': 'Ohereza muri PDF',
  Members: 'Abagize umushinga', 'New project': 'Umushinga mushya', Loading: 'Biri gukorwa', 'Nothing here yet': 'Nta kintu kirimo', Role: 'Uruhare', Today: 'Uyu munsi',
  'Amounts are accounting costs, not cash.': 'Aya mafaranga ni ibiciro by\'ibaruramari, si amafaranga yishyuwe.',
  'Profit is calculated from costs, never from cash received.': 'Inyungu ibarwa hakurikijwe ibiciro, ntiyigera ibarwa hakurikijwe amafaranga yinjiye.',
  'Original and approved budget are kept separate.': 'Ingengo y\'imari y\'ibanze n\'iyemejwe birabikwa ukwabyo.',
  'Build on time. Stay on budget.': 'Ubaka ku gihe. Ugumane ingengo y\'imari.', 'Control every site, cost and schedule from one place.': 'Kurikirana buri site, ikiguzi n\'igihe cy\'imirimo ahantu hamwe.',
  'Every project on one dashboard': 'Imishinga yose ku mbonerahamwe imwe', 'Budget, cash and profit you can trust': 'Ingengo y\'imari, amafaranga n\'inyungu wakwizera', 'Daily reports from the site, on any phone': 'Raporo z\'umunsi ziturutse ku site, kuri telefoni iyo ari yo yose',
  'Request access': 'Saba kwinjira', 'Request received': 'Ubusabe bwakiriwe', 'Full name': 'Amazina yose', Phone: 'Telefone', 'Confirm password': 'Subiramo ijambo ry\'ibanga',
  'At least 8 characters, with letters and digits': 'Nibura inyuguti 8, harimo inyuguti n\'imibare', 'Passwords do not match': 'Amagambo y\'ibanga ntahuye',
  'Who are you and which project do you work on?': 'Uri nde kandi ukora ku wuhe mushinga?',
  'An administrator will review your request and activate your account. You can then sign in with the email and password you chose.': 'Umuyobozi azasuzuma ubusabe bwawe maze afungure konti yawe. Ukazinjira ukoresheje imeri n\'ijambo ry\'ibanga wahisemo.',
  'Forgot your password? Ask your administrator to reset it.': 'Wibagiwe ijambo ry\'ibanga? Saba umuyobozi kuryongera gushyiraho.',
  'My profile': 'Konti yanjye', 'Change password': 'Hindura ijambo ry\'ibanga', 'Current password': 'Ijambo ry\'ibanga risanzwe', 'New password': 'Ijambo ry\'ibanga rishya',
  'Access requests': 'Ubusabe bwo kwinjira', 'Add user': 'Ongeramo ukoresha',
  'The server is not connected': 'Seriveri ntihujwe', '(not set)': '(nta yashyizweho)',
  'The web app cannot reach the API, or the API refuses this website (set CORS_ORIGIN on the API).': 'Urubuga ntirushobora kugera kuri API, cyangwa API irabuza uru rubuga (shyiraho CORS_ORIGIN kuri API).',
  'No API was found at this address. Deploy the API and set VITE_API_URL, then redeploy the web app.': 'Nta API ibonetse kuri iyi aderesi. Shyiraho API, ushyireho VITE_API_URL, hanyuma wongere ushyire urubuga kuri Netlify.',
  'Cannot reach the server': 'Seriveri ntibonetse', 'The web app is online, but the BuildTrack server (API) is not connected, so sign in and requests cannot work yet.': 'Urubuga ruriho, ariko seriveri ya BuildTrack (API) ntihujwe, bityo kwinjira no gusaba ntibishoboka kugeza ihujwe.',
  Actions: 'Ibyo gukora', Active: 'Irimo gukorwa', Planning: 'Iteganywa', 'On hold': 'Yarahagaritswe', Completed: 'Yarangiye', Open: 'Ifunguye', Pending: 'Itegereje', Cancelled: 'Yahagaritswe',
  Thresholds: 'Imipaka y\'iburira', 'Back up now': 'Bika kopi y\'umutekano ubu', Backups: 'Kopi z\'umutekano',
};

const fr = {
  'Sign in': 'Se connecter', 'Sign out': 'Se déconnecter', Email: 'E-mail', Password: 'Mot de passe', Language: 'Langue',
  Dashboard: 'Tableau de bord', Projects: 'Projets', Project: 'Projet', Overview: 'Aperçu', Baseline: 'Référence',
  'Daily reports': 'Rapports journaliers', Materials: 'Matériaux', Finance: 'Finances', Schedule: 'Planning', Variations: 'Avenants budgétaires',
  Documents: 'Documents', Audit: 'Audit', Users: 'Utilisateurs', Settings: 'Paramètres', Reports: 'Rapports',
  Save: 'Enregistrer', Cancel: 'Annuler', Submit: 'Soumettre', Approve: 'Approuver', Reject: 'Rejeter', Add: 'Ajouter', Delete: 'Supprimer', Create: 'Créer', Close: 'Fermer', Refresh: 'Actualiser',
  Name: 'Nom', Code: 'Code', Status: 'Statut', Date: 'Date', Amount: 'Montant', Quantity: 'Quantité', Unit: 'Unité', Reason: 'Motif', Note: 'Note',
  'Contract value': 'Valeur du contrat', Client: 'Client', Progress: 'Avancement', 'Planned end': 'Fin prévue', 'Forecast end': 'Fin prévisionnelle',
  'Original budget': 'Budget initial', 'Approved variations': 'Avenants approuvés', 'Revised budget': 'Budget révisé', 'Pending variations': 'Avenants en attente',
  'Actual cost': 'Coût réel', 'Committed cost': 'Coût engagé', 'Forecast final cost': 'Coût final prévisionnel', 'Forecast profit': 'Profit prévisionnel',
  'Forecast margin': 'Marge prévisionnelle', 'Budget used': 'Budget consommé', 'Remaining budget': 'Budget restant',
  'Cash received': 'Encaissements', 'Cash paid': 'Décaissements', 'Net cash': 'Trésorerie nette', Receivable: 'Créances',
  Invoices: 'Factures', Bills: 'Factures fournisseurs', 'Cash book': 'Journal de caisse', Costs: 'Coûts', 'Cash flow': 'Flux de trésorerie',
  actual: 'réel', estimated: 'estimé', forecast: 'prévisionnel', awaiting_approval: 'en attente d\'approbation',
  'Active projects': 'Projets actifs', 'Delayed projects': 'Projets en retard', 'Over budget': 'Dépassement budgétaire', 'Material shortages': 'Pénuries de matériaux',
  Alerts: 'Alertes', 'No alerts': 'Aucune alerte', Activities: 'Activités', Activity: 'Activité', 'Planned qty': 'Qté prévue', 'Done qty': 'Qté réalisée',
  'Import BOQ from Excel': 'Importer le BOQ depuis Excel', 'Approve baseline': 'Approuver la référence', 'New report': 'Nouveau rapport', 'Report date': 'Date du rapport',
  Weather: 'Météo', Delays: 'Retards', Problems: 'Problèmes', Workers: 'Ouvriers', Hours: 'Heures', Trade: 'Corps de métier', Equipment: 'Équipement', Labour: 'Main-d\'œuvre',
  Consumed: 'Consommé', Wasted: 'Perdu', Photos: 'Photos', Draft: 'Brouillon', Submitted: 'Soumis', Approved: 'Approuvé', Rejected: 'Rejeté',
  'Material requests': 'Demandes de matériaux', 'New request': 'Nouvelle demande', 'Needed date': 'Date requise', Requested: 'Demandé', Purchased: 'Acheté', Delivered: 'Livré', Received: 'Reçu', Issued: 'Sorti vers le chantier',
  Inventory: 'Stock', 'Purchase orders': 'Bons de commande', Deliveries: 'Livraisons', Supplier: 'Fournisseur', 'Unit price': 'Prix unitaire', 'Delivery note': 'Bon de livraison',
  Store: 'Magasin', Site: 'Chantier', Reserved: 'Réservé', 'On order': 'Commandé', Shortage: 'Manque', Required: 'Requis',
  'Confirm receipt': 'Confirmer la réception', 'Issue to site': 'Sortir vers le chantier', 'Stock adjustment': 'Ajustement de stock',
  'Record payment': 'Enregistrer un paiement', 'New invoice': 'Nouvelle facture', 'New bill': 'Nouvelle facture fournisseur', 'New cost': 'Nouveau coût', Reference: 'Référence', 'Due date': 'Échéance',
  'Awaiting approval': 'En attente d\'approbation', Reverse: 'Annuler (contre-passation)', 'Delay (days)': 'Retard (jours)', 'Propose revised schedule': 'Proposer un planning révisé',
  'Management report': 'Rapport de gestion', Daily: 'Quotidien', Weekly: 'Hebdomadaire', Monthly: 'Mensuel', 'Export Excel': 'Exporter Excel', 'Export PDF': 'Exporter PDF',
  Members: 'Membres', 'New project': 'Nouveau projet', Loading: 'Chargement', 'Nothing here yet': 'Rien pour le moment', Role: 'Rôle', Today: 'Aujourd\'hui',
  'Amounts are accounting costs, not cash.': 'Ces montants sont des coûts comptables, pas de la trésorerie.',
  'Profit is calculated from costs, never from cash received.': 'Le profit est calculé à partir des coûts, jamais des encaissements.',
  'Original and approved budget are kept separate.': 'Le budget initial et le budget approuvé sont conservés séparément.',
  'Build on time. Stay on budget.': 'Construisez dans les délais. Respectez le budget.', 'Control every site, cost and schedule from one place.': 'Pilotez chaque chantier, coût et planning depuis un seul endroit.',
  'Every project on one dashboard': 'Tous vos projets sur un seul tableau de bord', 'Budget, cash and profit you can trust': 'Budget, trésorerie et profit fiables', 'Daily reports from the site, on any phone': 'Rapports journaliers du chantier, sur tout téléphone',
  'Request access': 'Demander un accès', 'Request received': 'Demande reçue', 'Full name': 'Nom complet', Phone: 'Téléphone', 'Confirm password': 'Confirmer le mot de passe',
  'At least 8 characters, with letters and digits': 'Au moins 8 caractères, avec lettres et chiffres', 'Passwords do not match': 'Les mots de passe ne correspondent pas',
  'Who are you and which project do you work on?': 'Qui êtes-vous et sur quel projet travaillez-vous ?',
  'An administrator will review your request and activate your account. You can then sign in with the email and password you chose.': 'Un administrateur examinera votre demande et activera votre compte. Vous pourrez ensuite vous connecter avec l\'e-mail et le mot de passe choisis.',
  'Forgot your password? Ask your administrator to reset it.': 'Mot de passe oublié ? Demandez à votre administrateur de le réinitialiser.',
  'My profile': 'Mon profil', 'Change password': 'Changer le mot de passe', 'Current password': 'Mot de passe actuel', 'New password': 'Nouveau mot de passe',
  'Access requests': 'Demandes d\'accès', 'Add user': 'Ajouter un utilisateur',
  'The server is not connected': 'Le serveur n\'est pas connecté', '(not set)': '(non défini)',
  'The web app cannot reach the API, or the API refuses this website (set CORS_ORIGIN on the API).': 'L\'application ne peut pas joindre l\'API, ou l\'API refuse ce site (définissez CORS_ORIGIN sur l\'API).',
  'No API was found at this address. Deploy the API and set VITE_API_URL, then redeploy the web app.': 'Aucune API à cette adresse. Déployez l\'API et définissez VITE_API_URL, puis redéployez l\'application web.',
  'Cannot reach the server': 'Serveur inaccessible', 'The web app is online, but the BuildTrack server (API) is not connected, so sign in and requests cannot work yet.': 'L\'application web est en ligne, mais le serveur BuildTrack (API) n\'est pas connecté : la connexion et les demandes ne peuvent pas fonctionner.',
  Actions: 'Actions', Active: 'Actif', Planning: 'Planification', 'On hold': 'En pause', Completed: 'Terminé', Open: 'Ouvert', Pending: 'En attente', Cancelled: 'Annulé',
  Thresholds: 'Seuils d\'alerte', 'Back up now': 'Sauvegarder maintenant', Backups: 'Sauvegardes',
};

const DICT = { en: {}, rw, fr };

export const I18nContext = createContext({ lang: 'en', t: (s) => s, setLang: () => {} });
export const useI18n = () => useContext(I18nContext);
export const makeT = (lang) => (s) => (DICT[lang] && DICT[lang][s]) || s;

export function money(n, lang = 'en') {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  const loc = { en: 'en-RW', rw: 'rw-RW', fr: 'fr-RW' }[lang];
  try { return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(Number(n)); } catch { return String(Math.round(n)); }
}

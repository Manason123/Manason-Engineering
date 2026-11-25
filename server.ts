import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { getStorage } from 'firebase-admin/storage';
import { and, desc, eq } from 'drizzle-orm';
import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };
import './src/lib/firebase-admin.ts';
import { adminAuth } from './src/lib/firebase-admin.ts';
import { db } from './src/db/index.ts';
import {
  cmsActivities,
  cmsAttendance,
  cmsAuditLogs,
  cmsCatalogItems,
  cmsClients,
  cmsDocuments,
  cmsExpenses,
  cmsMaterialRequests,
  cmsMaterials,
  cmsNotifications,
  cmsPayments,
  cmsPhotos,
  cmsProgressReports,
  cmsProjectMembers,
  cmsProjects,
  cmsRequestItems,
  cmsStockTransactions,
  cmsSuppliers,
  cmsUsers,
  cmsWorkers,
} from './src/db/schema.ts';
import { ensureSeeded } from './src/db/seed.ts';
import {
  AuthDeniedError,
  authenticateWithPassword,
  getCmsUserById,
  getOrCreateCmsUser,
  hashPassword,
  sanitizeUser,
} from './src/db/users.ts';
import {
  signSessionToken,
  signWorkerCheckinToken,
  verifySessionToken,
  verifyWorkerCheckinToken,
} from './src/lib/session-token.ts';
import { type AuthRequest, extractAuthToken, requireAuth, requireRole } from './src/middleware/auth.ts';
import {
  authenticatePhonePin,
  type CheckinActor,
  getCheckinContext,
  performSelfCheckinAction,
  setUserPinAdmin,
  setWorkerPinAdmin,
} from './src/db/checkin-service.ts';
import {
  dispatchExternalNotifications,
  formatNotificationMoney,
  getPushClientConfig,
  getUserNotificationsList,
  markAllUserNotificationsRead,
  markUserNotificationRead,
  type QueuedNotificationDispatch,
  queueProjectNotifications,
  removeUserPushSubscription,
  saveUserPushSubscription,
  updateUserPreferredLang,
} from './src/db/notification-service.ts';
import {
  assertProjectAccess,
  assertProjectDuty,
  assertRole,
  BadRequestError,
  type CmsRole,
  createMaterialRequest,
  createProjectComment,
  decideMaterialRequest,
  decideProgressReport,
  ForbiddenError,
  getAccessibleProjects,
  getAdminGovernanceData,
  getOngoingProjectMeta,
  getProjectComments,
  getProjectDetail,
  getPublicShowcase,
  getRoleDashboardData,
  getSiteSettings,
  getUserProjectRolesMap,
  loadStarterActivitiesForProject,
  NotFoundError,
  processMaterialRequestStep,
  recordMaterialPurchase,
  recordStockTransaction,
  registerOngoingProject,
  updateSiteSettings,
} from './src/db/cms-service.ts';
import {
  getPortfolioPerformance,
  getProjectPerformance,
} from './src/db/performance-service.ts';
import {
  commitMaterialsImport,
  commitWorkersImport,
  exportAttendanceWorkbook,
  exportDailyCostsWorkbook,
  exportMaterialRequestGridWorkbook,
  exportMaterialsWorkbook,
  exportProgressReportWorkbook,
  exportPurchaseReceivingWorkbook,
  exportQcRegisterWorkbook,
  exportStockSheetWorkbook,
  exportSubmittedMaterialRequestWorkbook,
  exportWorkersWorkbook,
  generateAttendanceTemplate,
  generateMaterialRequestTemplate,
  generateMaterialsTemplate,
  generateWorkersTemplate,
  parseAttendanceSpreadsheet,
  parseMaterialRequestSpreadsheet,
  previewMaterialsImport,
  previewWorkersImport,
} from './src/db/excel-service.ts';
import {
  exportDailyCostsPdf,
  exportMaterialRequestPdf,
  exportProgressReportPdf,
  exportPurchaseReceivingPdf,
  exportQcRegisterPdf,
  exportStockSheetPdf,
  exportWorkersDailySheetPdf,
} from './src/db/document-pdf-service.ts';
import {
  createQcTest,
  createSurveyRecord,
  getAuthorizedQcSurveyAttachment,
  getQcTestHistory,
  listQcTests,
  listSurveyRecords,
  updateQcTest,
  updateSurveyRecord,
} from './src/db/qc-survey-service.ts';
import {
  getPortfolioPayrollSummary,
  getProjectSiteMapData,
  maskNationalId,
  reviewAttendanceBatch,
  submitAttendanceBatch,
  updateWorkerAdmin,
} from './src/db/workforce-service.ts';
import {
  addCatalogItem,
  exportCatalogFile,
  importCatalogData,
  listCatalogItems,
  getSelectableCatalogItems,
  mergeCatalogItems,
  updateCatalogItem,
} from './src/db/catalog-service.ts';
import {
  archiveProjectAdmin,
  exportProjectFullExcelAdmin,
  exportProjectFullPdfAdmin,
  getArchivedProjectsAdmin,
  getProjectExportStatusAdmin,
  permanentlyDeleteProjectAdmin,
  restoreProjectAdmin,
} from './src/db/project-lifecycle-service.ts';
import {
  addConfiguredLanguage,
  deleteConfiguredLanguage,
  getConfiguredLanguages,
  isSupportedConfiguredLang,
} from './src/db/language-service.ts';
import {
  registerApiNotFound,
  registerRequestLogging,
} from './src/middleware/diagnostics.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_UPLOADS_DIR = path.resolve(__dirname, 'public', 'uploads');
const LOGO_UPLOADS_DIR = path.join(PUBLIC_UPLOADS_DIR, 'logos');
const PROJECT_LOGOS_DIR = path.join(PUBLIC_UPLOADS_DIR, 'project-logos');
const PHOTO_UPLOADS_DIR = path.join(PUBLIC_UPLOADS_DIR, 'project-photos');
fs.mkdirSync(LOGO_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PROJECT_LOGOS_DIR, { recursive: true });
fs.mkdirSync(PHOTO_UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '15mb' }));
registerRequestLogging(app);
app.use(
  '/uploads',
  express.static(PUBLIC_UPLOADS_DIR, {
    maxAge: '7d',
  })
);

function handleApiError(res: Response, error: unknown, fallback = 'Request failed') {
  if (
    error instanceof ForbiddenError ||
    error instanceof BadRequestError ||
    error instanceof NotFoundError
  ) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(fallback, error);
  const message =
    error instanceof Error && error.message ? error.message : fallback;
  return res.status(500).json({ error: message });
}

// PUBLIC SHOWCASE & SITE SETTINGS
app.get('/api/public/showcase', async (_req: Request, res: Response) => {
  try {
    await ensureSeeded();
    const data = await getPublicShowcase();
    res.json(data);
  } catch (error) {
    handleApiError(res, error, 'Failed to load public portfolio');
  }
});

app.get('/api/public/site-settings', async (_req: Request, res: Response) => {
  try {
    await ensureSeeded();
    const settings = await getSiteSettings();
    res.json(settings);
  } catch (error) {
    handleApiError(res, error, 'Failed to load site settings');
  }
});

app.get('/api/languages', async (_req: Request, res: Response) => {
  try {
    const languages = await getConfiguredLanguages();
    res.json({ languages });
  } catch (error) {
    handleApiError(res, error, 'Failed to load languages');
  }
});

app.post(
  '/api/admin/languages',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await addConfiguredLanguage(req.cmsUser!, req.body || {});
      res.status(201).json({ language: created });
    } catch (error) {
      handleApiError(res, error, 'Failed to add language');
    }
  }
);

app.delete(
  '/api/admin/languages/:code',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      await deleteConfiguredLanguage(req.cmsUser!, String(req.params.code || ''));
      res.json({ ok: true });
    } catch (error) {
      handleApiError(res, error, 'Failed to delete language');
    }
  }
);

// PUBLIC CONTACT INQUIRY
app.post('/api/public/contact', async (req: Request, res: Response) => {
  try {
    const { name, email, phone, serviceType, message } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim();
    const cleanMessage = String(message || '').trim();
    if (!cleanName || !cleanEmail || !cleanEmail.includes('@') || !cleanMessage) {
      throw new BadRequestError('Name, valid email, and message are required');
    }
    res.status(201).json({
      ok: true,
      receivedAt: new Date().toISOString(),
      reference: `MN-${Date.now().toString(36).toUpperCase()}`,
      serviceType: String(serviceType || 'general'),
      phone: String(phone || '').trim() || null,
    });
  } catch (error) {
    handleApiError(res, error, 'Failed to submit contact inquiry');
  }
});

// EMAIL + PASSWORD LOGIN (No public registration: accounts created only by Super Admin)
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    await ensureSeeded();
    const { email, password } = req.body || {};
    const user = await authenticateWithPassword(
      String(email || ''),
      String(password || '')
    );
    const token = signSessionToken(user.id, user.role);
    res.json({ token, user });
  } catch (error) {
    if (error instanceof AuthDeniedError) {
      return res.status(error.status).json({
        code: error.code,
        error: error.message,
      });
    }
    handleApiError(res, error, 'Login failed');
  }
});

// PHONE + PIN LOGIN (Workers & non-client Staff for self check-in/out)
app.post('/api/auth/login-phone', async (req: Request, res: Response) => {
  try {
    await ensureSeeded();
    const { phone, pin } = req.body || {};
    const result = await authenticatePhonePin(
      String(phone || ''),
      String(pin || '')
    );
    if (result.kind === 'staff') {
      const token = signSessionToken(result.user.id, result.user.role);
      return res.json({ kind: 'staff', token, user: result.user });
    }
    const token = signWorkerCheckinToken(
      result.worker.id,
      result.worker.projectId || ''
    );
    return res.json({ kind: 'worker', token, worker: result.worker });
  } catch (error) {
    if (error instanceof AuthDeniedError) {
      return res.status(error.status).json({
        code: error.code,
        error: error.message,
      });
    }
    handleApiError(res, error, 'Phone PIN login failed');
  }
});

interface CheckinRequest extends Request {
  checkinActor?: CheckinActor;
}

const requireCheckinActor = async (
  req: CheckinRequest,
  res: Response,
  next: express.NextFunction
) => {
  const token = extractAuthToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing bearer token' });
  }

  try {
    if (token.startsWith('cms-worker.')) {
      const payload = verifyWorkerCheckinToken(token);
      if (!payload) {
        return res
          .status(401)
          .json({ error: 'Unauthorized: Invalid or expired worker session' });
      }
      req.checkinActor = { kind: 'worker', workerId: payload.wid };
      return next();
    }

    let cmsUser = null;
    if (token.startsWith('cms.')) {
      const payload = verifySessionToken(token);
      if (!payload) {
        return res
          .status(401)
          .json({ error: 'Unauthorized: Invalid or expired session' });
      }
      const dbUser = await getCmsUserById(payload.uid);
      if (!dbUser) {
        return res
          .status(401)
          .json({ error: 'Unauthorized: Account not found' });
      }
      cmsUser = sanitizeUser(dbUser);
    } else {
      const decodedToken = await adminAuth.verifyIdToken(token);
      cmsUser = await getOrCreateCmsUser(
        decodedToken.uid,
        decodedToken.email,
        decodedToken.name
      );
    }

    if (cmsUser.status === 'suspended' || cmsUser.status === 'deactivated') {
      return res.status(403).json({
        error: 'Account is not active. Contact a Super Admin.',
      });
    }
    if (cmsUser.role === 'client') {
      return res.status(403).json({
        code: 'ROLE_FORBIDDEN',
        error: 'Client accounts cannot access site GPS check-in.',
      });
    }

    req.checkinActor = { kind: 'staff', user: cmsUser };
    return next();
  } catch (error) {
    if (error instanceof AuthDeniedError) {
      return res
        .status(error.status)
        .json({ code: error.code, error: error.message });
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid session token' });
  }
};

// SELF-SERVICE ONE-SHOT GPS CHECK-IN & CHECK-OUT (Workers + Staff)
app.get(
  '/api/checkin/me',
  requireCheckinActor,
  async (req: CheckinRequest, res: Response) => {
    try {
      const data = await getCheckinContext(req.checkinActor!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load check-in status');
    }
  }
);

app.post(
  '/api/checkin/in',
  requireCheckinActor,
  async (req: CheckinRequest, res: Response) => {
    try {
      const result = await performSelfCheckinAction(
        req.checkinActor!,
        'check_in',
        req.body || {}
      );
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Check-in failed');
    }
  }
);

app.post(
  '/api/checkin/out',
  requireCheckinActor,
  async (req: CheckinRequest, res: Response) => {
    try {
      const result = await performSelfCheckinAction(
        req.checkinActor!,
        'check_out',
        req.body || {}
      );
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Check-out failed');
    }
  }
);

// ROLE-SPECIFIC DASHBOARDS (strict server-side role enforcement)
app.get(
  '/api/dashboard/super_admin',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load super admin dashboard');
    }
  }
);

app.get(
  '/api/dashboard/project_manager',
  requireAuth,
  requireRole('project_manager'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load project manager dashboard');
    }
  }
);

app.get(
  '/api/dashboard/engineer',
  requireAuth,
  requireRole('engineer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load engineer dashboard');
    }
  }
);

app.get(
  '/api/dashboard/storekeeper',
  requireAuth,
  requireRole('storekeeper'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load storekeeper dashboard');
    }
  }
);

app.get(
  '/api/dashboard/timekeeper',
  requireAuth,
  requireRole('timekeeper'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load timekeeper dashboard');
    }
  }
);

app.get(
  '/api/dashboard/foreman',
  requireAuth,
  requireRole('foreman'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load foreman dashboard');
    }
  }
);

app.get(
  '/api/dashboard/client',
  requireAuth,
  requireRole('client'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load client dashboard');
    }
  }
);

app.get(
  '/api/dashboard/quality_control',
  requireAuth,
  requireRole('quality_control'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load quality control dashboard');
    }
  }
);

app.get(
  '/api/dashboard/surveyor',
  requireAuth,
  requireRole('surveyor'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getRoleDashboardData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load surveyor dashboard');
    }
  }
);

// CURRENT AUTHENTICATED USER PROFILE & NOTIFICATIONS
app.get('/api/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await ensureSeeded();
    const user = req.cmsUser!;
    const [notifData, projects] = await Promise.all([
      getUserNotificationsList(user.id, 50),
      getAccessibleProjects(user),
    ]);
    const canSeeSuppliers =
      user.role === 'super_admin' ||
      user.role === 'storekeeper' ||
      projects.some((p) =>
        p.projectRoles?.some(
          (r) => r === 'storekeeper' || r === 'project_manager'
        )
      );
    const suppliers = canSeeSuppliers
      ? await db.select().from(cmsSuppliers).orderBy(cmsSuppliers.name)
      : [];
    res.json({
      user,
      notifications: notifData.notifications,
      unreadCount: notifData.unreadCount,
      projects,
      suppliers,
    });
  } catch (error) {
    handleApiError(res, error, 'Failed to load user workspace');
  }
});

app.patch(
  '/api/me/language',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const validCode = await isSupportedConfiguredLang(req.body?.lang);
      if (!validCode) {
        throw new BadRequestError('Unsupported language.');
      }
      const preferredLang = await updateUserPreferredLang(user.id, validCode);
      res.json({ ok: true, preferredLang });
    } catch (error) {
      handleApiError(res, error, 'Failed to save language preference');
    }
  }
);

app.get(
  '/api/notifications',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const limit = Number(req.query.limit || 50);
      const data = await getUserNotificationsList(user.id, limit);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load notifications');
    }
  }
);

app.post(
  '/api/notifications/read-all',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      await markAllUserNotificationsRead(user.id);
      res.json({ ok: true });
    } catch (error) {
      handleApiError(res, error, 'Failed to mark notifications as read');
    }
  }
);

app.get(
  '/api/notifications/push-config',
  requireAuth,
  async (_req: AuthRequest, res: Response) => {
    res.json(getPushClientConfig());
  }
);

app.post(
  '/api/notifications/push-subscribe',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const sub = req.body?.subscription ?? req.body;
      const saved = await saveUserPushSubscription(
        user.id,
        sub,
        req.headers['user-agent'] || null
      );
      res.status(201).json({ ok: true, id: saved.id });
    } catch (error) {
      handleApiError(res, error, 'Failed to save push subscription');
    }
  }
);

app.post(
  '/api/notifications/push-unsubscribe',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const endpoint = String(req.body?.endpoint || '').trim();
      await removeUserPushSubscription(user.id, endpoint);
      res.json({ ok: true });
    } catch (error) {
      handleApiError(res, error, 'Failed to remove push subscription');
    }
  }
);

app.post(
  '/api/notifications/:id/read',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const id = String(req.params.id);
      await markUserNotificationRead(user.id, id);
      res.json({ ok: true });
    } catch (error) {
      handleApiError(res, error, 'Failed to update notification');
    }
  }
);

// PROJECTS
app.get('/api/projects', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await ensureSeeded();
    const projects = await getAccessibleProjects(req.cmsUser!);
    res.json(projects);
  } catch (error) {
    handleApiError(res, error, 'Failed to list projects');
  }
});

// SUPER ADMIN WIZARD: REGISTER ONGOING PROJECT (strictly before /api/projects/:id)
app.get(
  '/api/projects/ongoing/meta',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      await ensureSeeded();
      const meta = await getOngoingProjectMeta(req.cmsUser!);
      res.json(meta);
    } catch (error) {
      handleApiError(res, error, 'Failed to load ongoing project wizard metadata');
    }
  }
);

app.post(
  '/api/projects/ongoing',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await registerOngoingProject(req.cmsUser!, req.body || {});
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to register ongoing project');
    }
  }
);

app.post('/api/projects', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.cmsUser!;
    assertRole(user, ['super_admin']);
    const {
      name,
      code,
      clientId,
      location,
      type,
      description,
      contractAmount,
      originalBudget,
      additionalBudget,
      startDate,
      expectedEndDate,
      status,
      showOnWebsite,
      loadStarterActivities,
    } = req.body;

    if (!name || !String(name).trim()) {
      throw new BadRequestError('Project name is required.');
    }

    const cleanCode = code
      ? String(code).trim().toUpperCase().slice(0, 32)
      : null;

    const created = await db.transaction(async (tx) => {
      const [proj] = await tx
        .insert(cmsProjects)
        .values({
          name: String(name).trim(),
          code: cleanCode || null,
          clientId: clientId || null,
          location: location || null,
          type: type || null,
          description: description || null,
          contractAmount: Number(contractAmount || 0).toFixed(2),
          originalBudget: Number(originalBudget || 0).toFixed(2),
          additionalBudget: Number(additionalBudget || 0).toFixed(2),
          startDate: startDate || null,
          expectedEndDate: expectedEndDate || null,
          status: status || 'planning',
          showOnWebsite: Boolean(showOnWebsite),
          createdBy: user.id,
        })
        .returning();

      if (loadStarterActivities) {
        const { STARTER_ACTIVITIES } = await import('./src/db/seed.ts');
        await tx.insert(cmsActivities).values(
          STARTER_ACTIVITIES.map((a) => ({
            projectId: proj.id,
            name: a.name,
            weight: a.weight,
            sortOrder: a.sortOrder,
            percentComplete: '0.00',
          }))
        );
      }

      return proj;
    });

    res.status(201).json(created);
  } catch (error) {
    handleApiError(res, error, 'Failed to create project');
  }
});

app.patch(
  '/api/projects/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const projectId = String(req.params.id);
      const [existing] = await db
        .select()
        .from(cmsProjects)
        .where(eq(cmsProjects.id, projectId))
        .limit(1);
      if (!existing) throw new NotFoundError('Project not found.');
      if (existing.isArchived) {
        throw new ForbiddenError('Restore this project before editing.');
      }

      const {
        status,
        code,
        logoUrl,
        additionalBudget,
        originalBudget,
        contractAmount,
        showOnWebsite,
        pmCanViewProfitLoss,
        description,
        location,
        expectedEndDate,
        gpsLat,
        gpsLng,
        gpsRadiusMeters,
      } = req.body;

      const patch: Partial<typeof cmsProjects.$inferInsert> = {};
      if (status !== undefined) patch.status = status;
      let brandingChanged = false;
      if (code !== undefined) {
        const cleanCode = code
          ? String(code).trim().toUpperCase().slice(0, 32)
          : null;
        if (cleanCode !== existing.code) {
          brandingChanged = true;
        }
        patch.code = cleanCode;
      }
      if (logoUrl !== undefined) {
        if (logoUrl === null || String(logoUrl).trim() === '') {
          if (existing.logoUrl !== null) brandingChanged = true;
          patch.logoUrl = null;
        } else {
          const cleanLogo = String(logoUrl).trim();
          if (
            !cleanLogo.startsWith('/uploads/') &&
            !cleanLogo.startsWith('https://')
          ) {
            throw new BadRequestError('Invalid project logo URL.');
          }
          if (cleanLogo !== existing.logoUrl) brandingChanged = true;
          patch.logoUrl = cleanLogo;
        }
      }
      if (additionalBudget !== undefined)
        patch.additionalBudget = Number(additionalBudget).toFixed(2);
      if (originalBudget !== undefined)
        patch.originalBudget = Number(originalBudget).toFixed(2);
      if (contractAmount !== undefined)
        patch.contractAmount = Number(contractAmount).toFixed(2);
      if (showOnWebsite !== undefined) patch.showOnWebsite = Boolean(showOnWebsite);
      const pmPlChanged =
        pmCanViewProfitLoss !== undefined &&
        Boolean(pmCanViewProfitLoss) !== Boolean(existing.pmCanViewProfitLoss);
      if (pmCanViewProfitLoss !== undefined) {
        patch.pmCanViewProfitLoss = Boolean(pmCanViewProfitLoss);
      }
      if (description !== undefined) patch.description = description;
      if (location !== undefined) patch.location = location;
      if (expectedEndDate !== undefined) patch.expectedEndDate = expectedEndDate || null;

      let gpsChanged = false;
      if (gpsLat !== undefined) {
        if (gpsLat === null || gpsLat === '') {
          patch.gpsLat = null;
          gpsChanged = true;
        } else {
          const latNum = Number(gpsLat);
          if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
            throw new BadRequestError('GPS latitude must be between -90 and 90.');
          }
          patch.gpsLat = latNum.toFixed(6);
          gpsChanged = true;
        }
      }
      if (gpsLng !== undefined) {
        if (gpsLng === null || gpsLng === '') {
          patch.gpsLng = null;
          gpsChanged = true;
        } else {
          const lngNum = Number(gpsLng);
          if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
            throw new BadRequestError('GPS longitude must be between -180 and 180.');
          }
          patch.gpsLng = lngNum.toFixed(6);
          gpsChanged = true;
        }
      }
      if (gpsRadiusMeters !== undefined) {
        const radNum = Math.round(Number(gpsRadiusMeters));
        if (!Number.isFinite(radNum) || radNum < 10 || radNum > 5000) {
          throw new BadRequestError(
            'Allowed GPS radius must be between 10 and 5000 meters.'
          );
        }
        patch.gpsRadiusMeters = radNum;
        gpsChanged = true;
      }

      const [updated] = await db
        .update(cmsProjects)
        .set(patch)
        .where(eq(cmsProjects.id, projectId))
        .returning();

      if (brandingChanged) {
        await db.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_projects',
          rowId: projectId,
          action: 'UPDATE_PROJECT_BRANDING',
          oldData: {
            code: existing.code,
            logoUrl: existing.logoUrl,
          },
          newData: {
            code: updated.code,
            logoUrl: updated.logoUrl,
          },
        });
      }

      if (gpsChanged) {
        await db.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_projects',
          rowId: projectId,
          action: 'UPDATE_GPS_GEOFENCE',
          oldData: {
            gpsLat: existing.gpsLat,
            gpsLng: existing.gpsLng,
            gpsRadiusMeters: existing.gpsRadiusMeters,
          },
          newData: {
            gpsLat: updated.gpsLat,
            gpsLng: updated.gpsLng,
            gpsRadiusMeters: updated.gpsRadiusMeters,
          },
        });
      }

      if (pmPlChanged) {
        await db.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_projects',
          rowId: projectId,
          action: 'UPDATE_PM_PROFIT_LOSS_ACCESS',
          oldData: {
            pmCanViewProfitLoss: Boolean(existing.pmCanViewProfitLoss),
          },
          newData: {
            pmCanViewProfitLoss: Boolean(updated.pmCanViewProfitLoss),
          },
        });
      }

      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update project');
    }
  }
);

app.post(
  '/api/projects/:id/logo',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const projectId = String(req.params.id);
      const [existing] = await db
        .select()
        .from(cmsProjects)
        .where(eq(cmsProjects.id, projectId))
        .limit(1);
      if (!existing) throw new NotFoundError('Project not found.');
      if (existing.isArchived) {
        throw new ForbiddenError('Restore this project before editing.');
      }

      const { fileName, mimeType, dataBase64 } = req.body || {};
      const ALLOWED_MIMES: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
      };
      const ext = ALLOWED_MIMES[String(mimeType || '').toLowerCase()];
      if (!ext) {
        throw new BadRequestError(
          'Unsupported logo format. Allowed: jpg, png, webp, svg.'
        );
      }

      const rawBase64 = String(dataBase64 || '').replace(
        /^data:[^;]+;base64,/,
        ''
      );
      if (!rawBase64) {
        throw new BadRequestError('Logo file content is required.');
      }

      let buffer = Buffer.from(rawBase64, 'base64');
      const MAX_BYTES = 2 * 1024 * 1024;
      if (buffer.length === 0 || buffer.length > MAX_BYTES) {
        throw new BadRequestError('Logo file must be between 1 byte and 2 MB.');
      }

      if (ext === 'jpg') {
        if (
          buffer.length < 3 ||
          buffer[0] !== 0xff ||
          buffer[1] !== 0xd8 ||
          buffer[2] !== 0xff
        ) {
          throw new BadRequestError('Invalid JPEG file signature.');
        }
      } else if (ext === 'png') {
        if (
          buffer.length < 8 ||
          buffer[0] !== 0x89 ||
          buffer[1] !== 0x50 ||
          buffer[2] !== 0x4e ||
          buffer[3] !== 0x47
        ) {
          throw new BadRequestError('Invalid PNG file signature.');
        }
      } else if (ext === 'webp') {
        if (
          buffer.length < 12 ||
          buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
          buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
        ) {
          throw new BadRequestError('Invalid WebP file signature.');
        }
      } else if (ext === 'svg') {
        const svgText = buffer.toString('utf8');
        if (!/<svg[\s>]/i.test(svgText)) {
          throw new BadRequestError('Invalid SVG file.');
        }
        const cleanedSvg = svgText
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
          .replace(/javascript:/gi, '');
        buffer = Buffer.from(cleanedSvg, 'utf8');
      }

      const safeBaseName =
        String(fileName || 'project-logo')
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 24) || 'project-logo';
      const objectName = `project-logos/${projectId.slice(0, 8)}-${safeBaseName}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

      let publicUrl = `/uploads/${objectName}`;
      try {
        if (firebaseConfig.storageBucket) {
          const bucket = getStorage().bucket(firebaseConfig.storageBucket);
          const [exists] = await bucket.exists();
          if (exists) {
            const file = bucket.file(objectName);
            await file.save(buffer, {
              contentType: String(mimeType),
              public: true,
              metadata: { cacheControl: 'public, max-age=31536000' },
            });
            publicUrl = `https://storage.googleapis.com/${firebaseConfig.storageBucket}/${objectName}`;
          } else {
            fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
          }
        } else {
          fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
        }
      } catch {
        fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
      }

      const [updated] = await db
        .update(cmsProjects)
        .set({ logoUrl: publicUrl })
        .where(eq(cmsProjects.id, projectId))
        .returning();

      await db.insert(cmsAuditLogs).values({
        userId: user.id,
        tableName: 'cms_projects',
        rowId: projectId,
        action: 'UPLOAD_PROJECT_LOGO',
        oldData: { logoUrl: existing.logoUrl },
        newData: { logoUrl: publicUrl },
      });

      res.status(201).json({ url: publicUrl, project: updated });
    } catch (error) {
      handleApiError(res, error, 'Failed to upload project logo');
    }
  }
);

app.get('/api/projects/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const detail = await getProjectDetail(req.cmsUser!, String(req.params.id));
    res.json(detail);
  } catch (error) {
    handleApiError(res, error, 'Failed to fetch project details');
  }
});

// SUPER ADMIN PROJECT ARCHIVE, RESTORE, EXPORT & PERMANENT DELETE
app.get(
  '/api/admin/projects/archived',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const archived = await getArchivedProjectsAdmin(req.cmsUser!);
      res.json({ projects: archived });
    } catch (error) {
      handleApiError(res, error, 'Failed to fetch archived projects');
    }
  }
);

app.post(
  '/api/projects/:id/archive',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await archiveProjectAdmin(
        req.cmsUser!,
        String(req.params.id)
      );
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to archive project');
    }
  }
);

app.post(
  '/api/projects/:id/restore',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await restoreProjectAdmin(
        req.cmsUser!,
        String(req.params.id)
      );
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to restore project');
    }
  }
);

app.get(
  '/api/projects/:id/export/excel',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { fileName, buffer } = await exportProjectFullExcelAdmin(
        req.cmsUser!,
        String(req.params.id)
      );
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      res.send(buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export project Excel archive');
    }
  }
);

app.get(
  '/api/projects/:id/export/pdf',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { fileName, buffer } = await exportProjectFullPdfAdmin(
        req.cmsUser!,
        String(req.params.id)
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      res.send(buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export project PDF archive');
    }
  }
);

app.get(
  '/api/projects/:id/export/status',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const status = await getProjectExportStatusAdmin(
        req.cmsUser!,
        String(req.params.id)
      );
      res.json(status);
    } catch (error) {
      handleApiError(res, error, 'Failed to check project export status');
    }
  }
);

app.delete(
  '/api/projects/:id/permanent',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await permanentlyDeleteProjectAdmin(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to permanently delete project');
    }
  }
);

// PROJECT & PORTFOLIO PERFORMANCE ANALYTICS
app.get(
  '/api/projects/:id/performance',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const performance = await getProjectPerformance(
        req.cmsUser!,
        String(req.params.id)
      );
      res.json(performance);
    } catch (error) {
      handleApiError(res, error, 'Failed to compute project performance');
    }
  }
);

app.get(
  '/api/performance/portfolio',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const portfolio = await getPortfolioPerformance(req.cmsUser!);
      res.json(portfolio);
    } catch (error) {
      handleApiError(res, error, 'Failed to compute portfolio performance');
    }
  }
);

app.get(
  '/api/projects/:id/performance/financials',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'project_manager',
      ]);
      const performance = await getProjectPerformance(req.cmsUser!, projectId);
      res.json({
        permissions: performance.permissions,
        dailyCosts: performance.dailyCosts,
        profitLoss: performance.profitLoss,
        budgetVsActual: performance.budgetVsActual,
        cashView: performance.cashView,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to compute financial performance');
    }
  }
);

const ALLOWED_PROJECT_ROLES = new Set<CmsRole>([
  'super_admin',
  'project_manager',
  'engineer',
  'storekeeper',
  'timekeeper',
  'foreman',
  'quality_control',
  'surveyor',
  'client',
]);

// PROJECT MEMBERS (Supports assigning multiple duties per user per project)
app.post(
  '/api/projects/:id/members',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const projectId = String(req.params.id);
      const { userId, memberRole, memberRoles } = req.body || {};

      if (!userId) {
        throw new BadRequestError('userId is required.');
      }

      const [targetUser] = await db
        .select({ id: cmsUsers.id })
        .from(cmsUsers)
        .where(eq(cmsUsers.id, String(userId)))
        .limit(1);
      if (!targetUser) {
        throw new NotFoundError('User not found.');
      }

      const [targetProj] = await db
        .select({ id: cmsProjects.id, isArchived: cmsProjects.isArchived })
        .from(cmsProjects)
        .where(eq(cmsProjects.id, projectId))
        .limit(1);
      if (!targetProj) {
        throw new NotFoundError('Project not found.');
      }
      if (targetProj.isArchived) {
        throw new ForbiddenError('Restore this project before assigning members.');
      }

      if (Array.isArray(memberRoles)) {
        const uniqueRoles = Array.from(
          new Set(
            memberRoles
              .map((r) => String(r) as CmsRole)
              .filter((r) => ALLOWED_PROJECT_ROLES.has(r))
          )
        );
        if (uniqueRoles.length === 0) {
          throw new BadRequestError('Select at least one valid project duty.');
        }

        const saved = await db.transaction(async (tx) => {
          await tx
            .delete(cmsProjectMembers)
            .where(
              and(
                eq(cmsProjectMembers.projectId, projectId),
                eq(cmsProjectMembers.userId, String(userId))
              )
            );
          const inserted = await tx
            .insert(cmsProjectMembers)
            .values(
              uniqueRoles.map((r) => ({
                projectId,
                userId: String(userId),
                memberRole: r,
                canViewBudget: r === 'project_manager' || r === 'super_admin',
              }))
            )
            .returning();

          await tx.insert(cmsAuditLogs).values({
            userId: user.id,
            tableName: 'cms_project_members',
            rowId: `${projectId}:${userId}`,
            action: 'SET_MEMBER_DUTIES',
            newData: {
              projectId,
              targetUserId: String(userId),
              memberRoles: uniqueRoles,
            },
          });

          return inserted;
        });

        return res.status(201).json({ members: saved, memberRoles: uniqueRoles });
      }

      const cleanRole = String(memberRole || '') as CmsRole;
      if (!cleanRole || !ALLOWED_PROJECT_ROLES.has(cleanRole)) {
        throw new BadRequestError('Valid memberRole or memberRoles is required.');
      }

      const [member] = await db
        .insert(cmsProjectMembers)
        .values({
          projectId,
          userId: String(userId),
          memberRole: cleanRole,
          canViewBudget:
            cleanRole === 'project_manager' || cleanRole === 'super_admin',
        })
        .onConflictDoNothing()
        .returning();

      await db.insert(cmsAuditLogs).values({
        userId: user.id,
        tableName: 'cms_project_members',
        rowId: `${projectId}:${userId}`,
        action: 'ADD_MEMBER_DUTY',
        newData: {
          projectId,
          targetUserId: String(userId),
          memberRole: cleanRole,
        },
      });

      res.status(201).json(
        member || {
          projectId,
          userId: String(userId),
          memberRole: cleanRole,
          canViewBudget:
            cleanRole === 'project_manager' || cleanRole === 'super_admin',
        }
      );
    } catch (error) {
      handleApiError(res, error, 'Failed to assign project member');
    }
  }
);

app.delete(
  '/api/projects/:id/members/:userId',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      assertRole(req.cmsUser!, ['super_admin']);
      const projectId = String(req.params.id);
      const targetUserId = String(req.params.userId);
      const roleFilter = req.query.role
        ? String(req.query.role)
        : req.body?.memberRole
        ? String(req.body.memberRole)
        : null;

      if (roleFilter && ALLOWED_PROJECT_ROLES.has(roleFilter as CmsRole)) {
        await db
          .delete(cmsProjectMembers)
          .where(
            and(
              eq(cmsProjectMembers.projectId, projectId),
              eq(cmsProjectMembers.userId, targetUserId),
              eq(cmsProjectMembers.memberRole, roleFilter as CmsRole)
            )
          );
      } else {
        await db
          .delete(cmsProjectMembers)
          .where(
            and(
              eq(cmsProjectMembers.projectId, projectId),
              eq(cmsProjectMembers.userId, targetUserId)
            )
          );
      }
      res.json({ ok: true });
    } catch (error) {
      handleApiError(res, error, 'Failed to remove project member');
    }
  }
);

// ACTIVITIES & PROGRESS REPORTS
app.post(
  '/api/projects/:id/activities/starter',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await loadStarterActivitiesForProject(
        req.cmsUser!,
        String(req.params.id)
      );
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to load starter activities');
    }
  }
);

app.post(
  '/api/projects/:id/activities',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const projectId = String(req.params.id);
      const { name, weight, sortOrder } = req.body;
      const numericWeight = Number(weight);
      if (!name || numericWeight <= 0 || numericWeight > 100) {
        throw new BadRequestError('Valid name and weight (0–100) are required.');
      }

      const [created] = await db
        .insert(cmsActivities)
        .values({
          projectId,
          name: String(name).trim(),
          weight: numericWeight.toFixed(2),
          sortOrder: Number(sortOrder || 0),
          percentComplete: '0.00',
        })
        .returning();
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to add activity');
    }
  }
);

app.patch(
  '/api/activities/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const activityId = String(req.params.id);
      const [existing] = await db
        .select()
        .from(cmsActivities)
        .where(eq(cmsActivities.id, activityId))
        .limit(1);

      if (!existing) throw new NotFoundError('Activity not found.');
      await assertProjectDuty(user, existing.projectId, [
        'super_admin',
        'project_manager',
        'engineer',
      ]);

      const { percentComplete, weight } = req.body;
      const patch: Partial<typeof cmsActivities.$inferInsert> = {};
      if (percentComplete !== undefined) {
        const pct = Number(percentComplete);
        if (pct < 0 || pct > 100) {
          throw new BadRequestError('Percent complete must be between 0 and 100.');
        }
        patch.percentComplete = pct.toFixed(2);
      }
      if (weight !== undefined && user.role === 'super_admin') {
        patch.weight = Number(weight).toFixed(2);
      }

      const [updated] = await db
        .update(cmsActivities)
        .set(patch)
        .where(eq(cmsActivities.id, activityId))
        .returning();

      if (percentComplete !== undefined) {
        await db.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_activities',
          rowId: existing.id,
          action: 'PROGRESS_UPDATE',
          oldData: {
            projectId: existing.projectId,
            percentComplete: Number(existing.percentComplete),
          },
          newData: {
            projectId: existing.projectId,
            percentComplete: Number(patch.percentComplete),
            weight: Number(existing.weight),
          },
        });
      }

      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update activity');
    }
  }
);

app.post(
  '/api/projects/:id/progress-reports',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const projectId = String(req.params.id);
      await assertProjectDuty(user, projectId, [
        'super_admin',
        'project_manager',
        'engineer',
        'foreman',
      ]);

      const { activityId, reportDate, kind, workDone, issues, percentMeasured } =
        req.body;

      const autoApprove = user.role === 'super_admin';
      const txOut = await db.transaction(async (tx) => {
        const [report] = await tx
          .insert(cmsProgressReports)
          .values({
            projectId,
            activityId: activityId || null,
            reportDate: reportDate || new Date().toISOString().slice(0, 10),
            kind: kind || 'daily',
            workDone: workDone || null,
            issues: issues || null,
            percentMeasured:
              percentMeasured !== undefined && percentMeasured !== ''
                ? Number(percentMeasured).toFixed(2)
                : null,
            status: autoApprove ? 'approved' : 'pending',
            author: user.id,
          })
          .returning();

        if (
          autoApprove &&
          report.activityId &&
          report.percentMeasured !== null
        ) {
          await tx
            .update(cmsActivities)
            .set({ percentComplete: report.percentMeasured })
            .where(eq(cmsActivities.id, report.activityId));
        }

        const [projRows, actRows] = await Promise.all([
          tx
            .select({ name: cmsProjects.name })
            .from(cmsProjects)
            .where(eq(cmsProjects.id, projectId))
            .limit(1),
          report.activityId
            ? tx
                .select({ name: cmsActivities.name })
                .from(cmsActivities)
                .where(eq(cmsActivities.id, report.activityId))
                .limit(1)
            : Promise.resolve([]),
        ]);

        const reportKind = String(report.kind || 'daily');
        const kindKey =
          reportKind === 'weekly' ? 'report.weekly' : 'report.daily';

        const externalQueue = await queueProjectNotifications(tx, {
          projectId,
          defaultLink: `project:${projectId}:progress:${report.id}`,
          roles: ['engineer', 'project_manager'],
          includeSuperAdmins: true,
          excludeUserId: user.id,
          standard: {
            titleKey: 'notif.progressReport.submitted.title',
            bodyKey: autoApprove
              ? 'notif.progressReport.submitted.bodyAutoApproved'
              : 'notif.progressReport.submitted.body',
            params: {
              projectName: projRows[0]?.name || 'Project',
              actorName: user.fullName,
              kindKey,
              activityName: actRows[0]?.name || 'General',
              reportDate: String(report.reportDate),
            },
          },
        });

        return { report, externalQueue };
      });

      await dispatchExternalNotifications(txOut.externalQueue);
      res.status(201).json(txOut.report);
    } catch (error) {
      handleApiError(res, error, 'Failed to submit progress report');
    }
  }
);

app.patch(
  '/api/progress-reports/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { status } = req.body;
      if (status !== 'approved' && status !== 'rejected') {
        throw new BadRequestError('Status must be approved or rejected.');
      }
      const updated = await decideProgressReport(
        req.cmsUser!,
        String(req.params.id),
        status
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to review progress report');
    }
  }
);

// STORE & MATERIALS
app.post(
  '/api/projects/:id/materials',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const projectId = String(req.params.id);
      const { canSeeMoney } = await assertProjectDuty(user, projectId, [
        'super_admin',
        'storekeeper',
      ]);

      const {
        name,
        category,
        unit,
        minStock,
        unitPrice,
        supplierId,
        openingStock,
        catalogItemId,
      } = req.body;

      let linkedCat: typeof cmsCatalogItems.$inferSelect | null = null;
      if (catalogItemId) {
        const [catRow] = await db
          .select()
          .from(cmsCatalogItems)
          .where(eq(cmsCatalogItems.id, String(catalogItemId)))
          .limit(1);
        if (!catRow || !catRow.isActive) {
          throw new BadRequestError('Selected catalog item is invalid or inactive.');
        }
        linkedCat = catRow;
      }

      const resolvedName = linkedCat
        ? linkedCat.variant
          ? `${linkedCat.item} - ${linkedCat.variant}`
          : linkedCat.item
        : String(name || '').trim();
      const resolvedUnit = linkedCat ? linkedCat.baseUnit : String(unit || '').trim();
      const resolvedCategory = linkedCat
        ? linkedCat.category
        : category || 'General';

      if (!resolvedName || !resolvedUnit) {
        throw new BadRequestError('Material name and unit are required.');
      }

      if (linkedCat?.type === 'S') {
        throw new BadRequestError(
          'Service items are costed per test and cannot hold physical store stock.'
        );
      }

      const initialQty =
        linkedCat?.type === 'E' ? 0 : Number(openingStock || 0);
      if (initialQty < 0) {
        throw new BadRequestError('Opening stock cannot be negative.');
      }

      const safePrice =
        canSeeMoney && unitPrice !== undefined && unitPrice !== ''
          ? Math.max(0, Number(unitPrice || 0)).toFixed(2)
          : '0.00';

      const created = await db.transaction(async (tx) => {
        const [mat] = await tx
          .insert(cmsMaterials)
          .values({
            projectId,
            catalogItemId: linkedCat ? linkedCat.id : null,
            name: resolvedName,
            category: resolvedCategory,
            unit: resolvedUnit,
            minStock: Number(minStock || 0).toFixed(2),
            unitPrice: safePrice,
            supplierId: supplierId || null,
            currentStock: initialQty.toFixed(2),
          })
          .returning();

        if (initialQty > 0) {
          await tx.insert(cmsStockTransactions).values({
            materialId: mat.id,
            projectId,
            type: 'opening',
            quantity: initialQty.toFixed(2),
            unitPrice: safePrice,
            supplierId: supplierId || null,
            deliveryDate: new Date().toISOString().slice(0, 10),
            receivedBy: user.fullName,
            note: 'Opening inventory balance',
            recordedBy: user.id,
          });
        }
        return mat;
      });

      res.status(201).json({
        ...created,
        unitPrice: canSeeMoney ? created.unitPrice : null,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to register material');
    }
  }
);

app.post(
  '/api/projects/:id/stock',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await recordStockTransaction(req.cmsUser!, {
        projectId: String(req.params.id),
        materialId: req.body.materialId,
        type: req.body.type,
        quantity: Number(req.body.quantity),
        unitPrice:
          req.body.unitPrice !== undefined && req.body.unitPrice !== ''
            ? Number(req.body.unitPrice)
            : null,
        supplierId: req.body.supplierId || null,
        deliveryDate: req.body.deliveryDate || null,
        receivedBy: req.body.receivedBy || null,
        note: req.body.note || null,
      });
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to record stock movement');
    }
  }
);

app.post(
  '/api/projects/:id/store/purchase',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await recordMaterialPurchase(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to record material purchase');
    }
  }
);

// MATERIAL REQUESTS
app.post(
  '/api/projects/:id/material-requests',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await createMaterialRequest(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to submit material request');
    }
  }
);

app.post(
  '/api/material-requests/:id/review',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await processMaterialRequestStep(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to process material request review');
    }
  }
);

app.patch(
  '/api/material-requests/:id/decide',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await decideMaterialRequest(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to process material request');
    }
  }
);

// WORKERS & ATTENDANCE
app.post(
  '/api/projects/:id/workers',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const projectId = String(req.params.id);
      const { canSeeMoney } = await assertProjectDuty(user, projectId, [
        'super_admin',
        'engineer',
        'foreman',
        'timekeeper',
      ]);

      const {
        fullName,
        nationalId,
        phone,
        email,
        jobCategory,
        profession,
        dailyWage,
      } = req.body;
      if (!fullName || !String(fullName).trim()) {
        throw new BadRequestError('Worker full name is required.');
      }

      const isSuperAdmin = user.role === 'super_admin';
      const safeWage = isSuperAdmin
        ? Math.max(0, Number(dailyWage || 0)).toFixed(2)
        : '0.00';
      const cleanNationalId = nationalId ? String(nationalId).trim() || null : null;

      const [worker] = await db
        .insert(cmsWorkers)
        .values({
          projectId,
          fullName: String(fullName).trim(),
          nationalId: cleanNationalId,
          phone: phone ? String(phone).trim() || null : null,
          email: email ? String(email).trim() || null : null,
          jobCategory: jobCategory || 'Civil Works',
          profession: profession || 'Site Artisan',
          dailyWage: safeWage,
          employmentStatus: 'active',
        })
        .returning();

      await db.insert(cmsAuditLogs).values({
        userId: user.id,
        tableName: 'cms_workers',
        rowId: worker.id,
        action: 'INSERT',
        newData: {
          projectId,
          fullName: worker.fullName,
          phone: worker.phone,
          nationalIdMasked: maskNationalId(worker.nationalId),
          dailyWage: isSuperAdmin ? Number(worker.dailyWage || 0) : undefined,
        },
      });

      const { pinHash: workerPinHash, ...safeCreatedWorker } = worker;
      res.status(201).json({
        ...safeCreatedWorker,
        hasPin: Boolean(workerPinHash),
        nationalId: isSuperAdmin ? worker.nationalId : maskNationalId(worker.nationalId),
        dailyWage: canSeeMoney ? Number(worker.dailyWage || 0) : 0,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to register worker');
    }
  }
);

app.patch(
  '/api/workers/:id',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await updateWorkerAdmin(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update worker');
    }
  }
);

app.patch(
  '/api/workers/:id/pin',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await setWorkerPinAdmin(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to set worker PIN');
    }
  }
);

app.post(
  '/api/projects/:id/attendance/batch',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await submitAttendanceBatch(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to submit daily attendance');
    }
  }
);

app.post(
  '/api/projects/:id/attendance',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      await assertProjectDuty(req.cmsUser!, String(req.params.id), [
        'super_admin',
        'foreman',
        'engineer',
        'timekeeper',
        'project_manager',
      ]);
      const { workerId, workDate, present, gps, allowUnverifiedOverride } =
        req.body || {};
      if (!workerId || !workDate) {
        throw new BadRequestError('workerId and workDate are required.');
      }
      const result = await submitAttendanceBatch(
        req.cmsUser!,
        String(req.params.id),
        {
          workDate: String(workDate),
          entries: [{ workerId: String(workerId), present: Boolean(present) }],
          gps: gps || null,
          allowUnverifiedOverride: Boolean(allowUnverifiedOverride),
        }
      );
      res.status(201).json(result.records[0] || result);
    } catch (error) {
      handleApiError(res, error, 'Failed to record attendance');
    }
  }
);

app.post(
  '/api/projects/:id/attendance/review-batch',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await reviewAttendanceBatch(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to batch review attendance');
    }
  }
);

app.patch(
  '/api/attendance/:id/review',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const attId = String(req.params.id);
      const { reviewStatus } = req.body;
      if (reviewStatus !== 'approved' && reviewStatus !== 'rejected') {
        throw new BadRequestError('Invalid reviewStatus.');
      }

      const [existing] = await db
        .select()
        .from(cmsAttendance)
        .where(eq(cmsAttendance.id, attId))
        .limit(1);
      if (!existing) throw new NotFoundError('Attendance record not found.');
      await assertProjectDuty(user, existing.projectId, [
        'super_admin',
        'project_manager',
        'engineer',
      ]);

      const txOut = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(cmsAttendance)
          .set({ reviewStatus, reviewedBy: user.id })
          .where(eq(cmsAttendance.id, attId))
          .returning();

        await tx.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_attendance',
          rowId: attId,
          action: 'REVIEW',
          oldData: { reviewStatus: existing.reviewStatus },
          newData: {
            projectId: existing.projectId,
            workDate: existing.workDate,
            reviewStatus: updated.reviewStatus,
          },
        });

        const [projRows, workerRows] = await Promise.all([
          tx
            .select({ name: cmsProjects.name })
            .from(cmsProjects)
            .where(eq(cmsProjects.id, existing.projectId))
            .limit(1),
          tx
            .select({ fullName: cmsWorkers.fullName })
            .from(cmsWorkers)
            .where(eq(cmsWorkers.id, existing.workerId))
            .limit(1),
        ]);

        const externalQueue = await queueProjectNotifications(tx, {
          projectId: existing.projectId,
          defaultLink: `project:${existing.projectId}:workforce:${existing.workDate}`,
          roles: ['project_manager'],
          explicitUserIds: existing.recordedBy ? [existing.recordedBy] : [],
          includeSuperAdmins: true,
          excludeUserId: user.id,
          standard: {
            titleKey: 'notif.attendance.reviewed.title',
            bodyKey: 'notif.attendance.reviewed.bodySingle',
            params: {
              projectName: projRows[0]?.name || 'Project',
              actorName: user.fullName,
              workerName: workerRows[0]?.fullName || 'Worker',
              workDate: String(existing.workDate),
              statusKey: `status.${reviewStatus}`,
            },
          },
        });

        return { updated, externalQueue };
      });

      await dispatchExternalNotifications(txOut.externalQueue);

      const {
        submittedLat: _sLat,
        submittedLng: _sLng,
        checkOutLat: _oLat,
        checkOutLng: _oLng,
        ...safeAtt
      } = txOut.updated;

      res.json({
        ...safeAtt,
        ...(user.role === 'super_admin'
          ? {
              submittedLat: txOut.updated.submittedLat,
              submittedLng: txOut.updated.submittedLng,
              checkOutLat: txOut.updated.checkOutLat,
              checkOutLng: txOut.updated.checkOutLng,
            }
          : {}),
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to review attendance');
    }
  }
);

app.get(
  '/api/projects/:id/site-map',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getProjectSiteMapData(
        req.cmsUser!,
        String(req.params.id)
      );
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load site map');
    }
  }
);

app.get(
  '/api/payroll/summary',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const summary = await getPortfolioPayrollSummary(req.cmsUser!);
      res.json(summary);
    } catch (error) {
      handleApiError(res, error, 'Failed to compute payroll summary');
    }
  }
);

// EXPENSES & PAYMENTS (Super Admin ONLY — 403 for all other roles)
app.post(
  '/api/projects/:id/expenses',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const projectId = String(req.params.id);
      await assertProjectAccess(user, projectId);

      const { expenseDate, category, description, amount, paymentMethod, receiptUrl } =
        req.body;
      const numAmount = Number(amount);
      if (!numAmount || numAmount <= 0) {
        throw new BadRequestError('Amount must be greater than zero.');
      }

      const txOut = await db.transaction(async (tx) => {
        const autoApprove = user.role === 'super_admin';
        const cleanCategory = String(category || 'other');
        const [exp] = await tx
          .insert(cmsExpenses)
          .values({
            projectId,
            expenseDate: expenseDate || new Date().toISOString().slice(0, 10),
            category: cleanCategory as typeof cmsExpenses.$inferInsert['category'],
            description: description || null,
            amount: numAmount.toFixed(2),
            paymentMethod: paymentMethod || 'Bank Transfer',
            receiptUrl: receiptUrl || null,
            recordedBy: user.id,
            status: autoApprove ? 'approved' : 'pending',
            approvedBy: autoApprove ? user.id : null,
          })
          .returning();

        await tx.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_expenses',
          rowId: exp.id,
          action: 'INSERT',
          newData: exp,
        });

        const [projRows] = await Promise.all([
          tx
            .select({ name: cmsProjects.name })
            .from(cmsProjects)
            .where(eq(cmsProjects.id, projectId))
            .limit(1),
        ]);

        const categoryKey = `expense.${cleanCategory}`;
        const externalQueue = await queueProjectNotifications(tx, {
          projectId,
          defaultLink: `project:${projectId}:finance:${exp.id}`,
          roles: ['project_manager'],
          includeSuperAdmins: true,
          excludeUserId: user.id,
          standard: {
            titleKey: 'notif.expense.recorded.title',
            bodyKey: 'notif.expense.recorded.bodyNoAmount',
            params: {
              projectName: projRows[0]?.name || 'Project',
              actorName: user.fullName,
              categoryKey,
              expenseDate: String(exp.expenseDate),
            },
          },
          withMoney: {
            titleKey: 'notif.expense.recorded.title',
            bodyKey: 'notif.expense.recorded.bodyWithAmount',
            params: {
              projectName: projRows[0]?.name || 'Project',
              actorName: user.fullName,
              categoryKey,
              amount: formatNotificationMoney(numAmount),
              description: String(description || cleanCategory),
              expenseDate: String(exp.expenseDate),
            },
          },
        });

        return { exp, externalQueue };
      });

      await dispatchExternalNotifications(txOut.externalQueue);
      res.status(201).json(txOut.exp);
    } catch (error) {
      handleApiError(res, error, 'Failed to record expense');
    }
  }
);

app.patch(
  '/api/expenses/:id/decide',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const expenseId = String(req.params.id);
      const { status } = req.body;
      if (status !== 'approved' && status !== 'rejected') {
        throw new BadRequestError('Status must be approved or rejected.');
      }

      const txOut = await db.transaction(async (tx) => {
        const [oldRow] = await tx
          .select()
          .from(cmsExpenses)
          .where(eq(cmsExpenses.id, expenseId))
          .limit(1);
        if (!oldRow) throw new NotFoundError('Expense not found.');

        const [row] = await tx
          .update(cmsExpenses)
          .set({ status, approvedBy: user.id })
          .where(eq(cmsExpenses.id, expenseId))
          .returning();

        await tx.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_expenses',
          rowId: row.id,
          action: 'UPDATE',
          oldData: oldRow,
          newData: row,
        });

        const [projRows] = await Promise.all([
          tx
            .select({ name: cmsProjects.name })
            .from(cmsProjects)
            .where(eq(cmsProjects.id, row.projectId))
            .limit(1),
        ]);

        const projName = projRows[0]?.name || 'Project';
        const categoryKey = `expense.${row.category}`;
        const statusKey = `status.${status}`;

        // Notify assigned PM + Super Admins (with amount, direct link to finance row)
        const financeQueue = await queueProjectNotifications(tx, {
          projectId: row.projectId,
          defaultLink: `project:${row.projectId}:finance:${row.id}`,
          roles: ['project_manager'],
          includeSuperAdmins: true,
          excludeUserId: user.id,
          standard: {
            titleKey: 'notif.expense.decided.title',
            bodyKey: 'notif.expense.decided.bodyNoAmount',
            params: {
              projectName: projName,
              actorName: user.fullName,
              categoryKey,
              expenseDate: String(row.expenseDate),
              statusKey,
            },
          },
          withMoney: {
            titleKey: 'notif.expense.decided.title',
            bodyKey: 'notif.expense.decided.bodyWithAmount',
            params: {
              projectName: projName,
              actorName: user.fullName,
              categoryKey,
              amount: formatNotificationMoney(Number(row.amount || 0)),
              expenseDate: String(row.expenseDate),
              statusKey,
            },
          },
        });

        let externalQueue: QueuedNotificationDispatch[] = financeQueue;
        // If recordedBy is a non-PM/non-SA assigned to the project, notify them without money fields
        if (
          oldRow.recordedBy &&
          oldRow.recordedBy !== user.id &&
          !financeQueue.some((q) => q.userId === oldRow.recordedBy)
        ) {
          const recorderQueue = await queueProjectNotifications(tx, {
            projectId: row.projectId,
            defaultLink: `project:${row.projectId}:progress`,
            roles: [],
            explicitUserIds: [oldRow.recordedBy],
            includeSuperAdmins: false,
            excludeUserId: user.id,
            standard: {
              titleKey: 'notif.expense.decided.title',
              bodyKey: 'notif.expense.decided.bodyNoAmount',
              params: {
                projectName: projName,
                actorName: user.fullName,
                categoryKey,
                expenseDate: String(row.expenseDate),
                statusKey,
              },
            },
          });
          externalQueue = [...financeQueue, ...recorderQueue];
        }

        return { row, externalQueue };
      });

      await dispatchExternalNotifications(txOut.externalQueue);
      res.json(txOut.row);
    } catch (error) {
      handleApiError(res, error, 'Failed to approve expense');
    }
  }
);

app.post(
  '/api/projects/:id/payments',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      assertRole(user, ['super_admin']);
      const projectId = String(req.params.id);
      const { paidOn, amount, method, reference } = req.body;
      const numAmount = Number(amount);
      if (!numAmount || numAmount <= 0) {
        throw new BadRequestError('Payment amount must be greater than zero.');
      }

      const created = await db.transaction(async (tx) => {
        const [pay] = await tx
          .insert(cmsPayments)
          .values({
            projectId,
            paidOn: paidOn || new Date().toISOString().slice(0, 10),
            amount: numAmount.toFixed(2),
            method: method || 'Wire Transfer',
            reference: reference || null,
            recordedBy: user.id,
          })
          .returning();

        await tx.insert(cmsAuditLogs).values({
          userId: user.id,
          tableName: 'cms_payments',
          rowId: pay.id,
          action: 'INSERT',
          newData: pay,
        });

        return pay;
      });

      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to record payment');
    }
  }
);

// PHOTOS & DOCUMENTS
async function savePublicPhotoBuffer(params: {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}): Promise<string> {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const rawBase64 = String(params.dataBase64 || '').includes(',')
    ? String(params.dataBase64).split(',')[1]
    : String(params.dataBase64 || '');

  if (!rawBase64) {
    throw new BadRequestError('Photo data is required.');
  }

  const buffer = Buffer.from(rawBase64, 'base64');
  if (buffer.length === 0) {
    throw new BadRequestError('Uploaded photo is empty.');
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new BadRequestError('Photo file exceeds the 5 MB limit.');
  }

  const extFromName = String(params.fileName || '')
    .toLowerCase()
    .split('.')
    .pop();
  const mime = String(params.mimeType || '').toLowerCase();

  let ext = '';
  let normalizedMime = '';
  if (mime === 'image/jpeg' || mime === 'image/jpg' || extFromName === 'jpg' || extFromName === 'jpeg') {
    ext = 'jpg';
    normalizedMime = 'image/jpeg';
  } else if (mime === 'image/png' || extFromName === 'png') {
    ext = 'png';
    normalizedMime = 'image/png';
  } else if (mime === 'image/webp' || extFromName === 'webp') {
    ext = 'webp';
    normalizedMime = 'image/webp';
  } else {
    throw new BadRequestError('Only JPG, PNG, and WebP images are allowed.');
  }

  if (ext === 'jpg') {
    if (
      buffer.length < 3 ||
      buffer[0] !== 0xff ||
      buffer[1] !== 0xd8 ||
      buffer[2] !== 0xff
    ) {
      throw new BadRequestError('Invalid JPEG file signature.');
    }
  } else if (ext === 'png') {
    if (
      buffer.length < 8 ||
      buffer[0] !== 0x89 ||
      buffer[1] !== 0x50 ||
      buffer[2] !== 0x4e ||
      buffer[3] !== 0x47
    ) {
      throw new BadRequestError('Invalid PNG file signature.');
    }
  } else if (ext === 'webp') {
    if (
      buffer.length < 12 ||
      buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
    ) {
      throw new BadRequestError('Invalid WebP file signature.');
    }
  }

  const safeBaseName =
    String(params.fileName || 'site-photo')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 24) || 'site-photo';
  const objectName = `project-photos/${safeBaseName}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const localFallbackUrl = `/uploads/${objectName}`;

  try {
    if (firebaseConfig.storageBucket) {
      const bucket = getStorage().bucket(firebaseConfig.storageBucket);
      const [exists] = await bucket.exists();
      if (exists) {
        const file = bucket.file(objectName);
        await file.save(buffer, {
          contentType: normalizedMime,
          public: true,
          metadata: { cacheControl: 'public, max-age=31536000' },
        });
        const gcsUrl = `https://storage.googleapis.com/${firebaseConfig.storageBucket}/${objectName}`;
        const probe = await fetch(gcsUrl, { method: 'HEAD' }).catch(() => null);
        if (probe && probe.ok) {
          return gcsUrl;
        }
      }
    }
  } catch {
    // Fall back cleanly to Express public /uploads bucket
  }

  fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
  return localFallbackUrl;
}

app.post(
  '/api/projects/:id/photos/upload',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const projectId = String(req.params.id);
      await assertProjectDuty(user, projectId, [
        'super_admin',
        'project_manager',
        'engineer',
        'foreman',
      ]);

      const { fileName, mimeType, dataBase64, caption, activityId, publicGallery } =
        req.body || {};

      let resolvedActivityName: string | null = null;
      const cleanActivityId = activityId ? String(activityId).trim() : null;
      if (cleanActivityId) {
        const [act] = await db
          .select()
          .from(cmsActivities)
          .where(
            and(
              eq(cmsActivities.id, cleanActivityId),
              eq(cmsActivities.projectId, projectId)
            )
          )
          .limit(1);
        if (!act) {
          throw new BadRequestError('Selected activity does not belong to this project.');
        }
        resolvedActivityName = act.name;
      }

      const publicUrl = await savePublicPhotoBuffer({
        fileName: String(fileName || 'site-photo.jpg'),
        mimeType: String(mimeType || 'image/jpeg'),
        dataBase64: String(dataBase64 || ''),
      });

      const autoDate = new Date().toISOString().slice(0, 10);
      const cleanCaption = caption ? String(caption).trim() : null;
      const isPublic = user.role === 'super_admin' ? Boolean(publicGallery) : false;

      const [photo] = await db
        .insert(cmsPhotos)
        .values({
          projectId,
          activityId: cleanActivityId,
          photoDate: autoDate,
          url: publicUrl,
          caption: cleanCaption,
          publicGallery: isPublic,
          uploadedBy: user.id,
        })
        .returning();

      await db.insert(cmsAuditLogs).values({
        userId: user.id,
        tableName: 'cms_photos',
        rowId: photo.id,
        action: 'INSERT',
        newData: {
          projectId,
          activityId: cleanActivityId,
          photoDate: autoDate,
          url: publicUrl,
        },
      });

      res.status(201).json({
        ...photo,
        activityId: photo.activityId || null,
        activityName: resolvedActivityName,
        photoDate: photo.photoDate || autoDate,
        uploadedBy: user.id,
        uploadedByName: user.fullName,
        createdAt: photo.createdAt
          ? photo.createdAt.toISOString()
          : new Date().toISOString(),
        comments: [],
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to upload photo');
    }
  }
);

app.post(
  '/api/projects/:id/photos',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const projectId = String(req.params.id);
      await assertProjectDuty(user, projectId, [
        'super_admin',
        'project_manager',
        'engineer',
        'foreman',
      ]);

      const { url, caption, publicGallery, activityId } = req.body;
      if (!url) throw new BadRequestError('Photo URL is required.');

      let resolvedActivityName: string | null = null;
      const cleanActivityId = activityId ? String(activityId).trim() : null;
      if (cleanActivityId) {
        const [act] = await db
          .select()
          .from(cmsActivities)
          .where(
            and(
              eq(cmsActivities.id, cleanActivityId),
              eq(cmsActivities.projectId, projectId)
            )
          )
          .limit(1);
        if (!act) {
          throw new BadRequestError('Selected activity does not belong to this project.');
        }
        resolvedActivityName = act.name;
      }

      const autoDate = new Date().toISOString().slice(0, 10);
      const [photo] = await db
        .insert(cmsPhotos)
        .values({
          projectId,
          activityId: cleanActivityId,
          photoDate: autoDate,
          url: String(url).trim(),
          caption: caption ? String(caption).trim() : null,
          publicGallery: user.role === 'super_admin' ? Boolean(publicGallery) : false,
          uploadedBy: user.id,
        })
        .returning();

      res.status(201).json({
        ...photo,
        activityId: photo.activityId || null,
        activityName: resolvedActivityName,
        photoDate: photo.photoDate || autoDate,
        uploadedBy: user.id,
        uploadedByName: user.fullName,
        createdAt: photo.createdAt
          ? photo.createdAt.toISOString()
          : new Date().toISOString(),
        comments: [],
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to save photo');
    }
  }
);

app.patch(
  '/api/photos/:id',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const photoId = String(req.params.id);
      const [existing] = await db
        .select()
        .from(cmsPhotos)
        .where(eq(cmsPhotos.id, photoId))
        .limit(1);
      if (!existing) throw new NotFoundError('Photo not found.');

      const { caption, activityId, publicGallery } = req.body || {};
      const nextCaption =
        caption !== undefined ? String(caption || '').trim() || null : existing.caption;

      let nextActivityId = existing.activityId;
      if (activityId !== undefined) {
        const cleanAct = activityId ? String(activityId).trim() : null;
        if (cleanAct) {
          const [act] = await db
            .select()
            .from(cmsActivities)
            .where(
              and(
                eq(cmsActivities.id, cleanAct),
                eq(cmsActivities.projectId, existing.projectId)
              )
            )
            .limit(1);
          if (!act) {
            throw new BadRequestError('Activity does not belong to this project.');
          }
        }
        nextActivityId = cleanAct;
      }

      const [updated] = await db
        .update(cmsPhotos)
        .set({
          caption: nextCaption,
          activityId: nextActivityId,
          publicGallery:
            publicGallery !== undefined ? Boolean(publicGallery) : existing.publicGallery,
        })
        .where(eq(cmsPhotos.id, photoId))
        .returning();

      await db.insert(cmsAuditLogs).values({
        userId: user.id,
        tableName: 'cms_photos',
        rowId: updated.id,
        action: 'UPDATE',
        oldData: existing,
        newData: updated,
      });

      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update photo');
    }
  }
);

app.delete(
  '/api/photos/:id',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const photoId = String(req.params.id);
      const [existing] = await db
        .select()
        .from(cmsPhotos)
        .where(eq(cmsPhotos.id, photoId))
        .limit(1);
      if (!existing) throw new NotFoundError('Photo not found.');

      await db.delete(cmsPhotos).where(eq(cmsPhotos.id, photoId));
      await db.insert(cmsAuditLogs).values({
        userId: user.id,
        tableName: 'cms_photos',
        rowId: photoId,
        action: 'DELETE',
        oldData: existing,
      });

      if (existing.url.startsWith('/uploads/project-photos/')) {
        const rel = existing.url.replace(/^\/uploads\//, '');
        const abs = path.join(PUBLIC_UPLOADS_DIR, rel);
        if (abs.startsWith(PHOTO_UPLOADS_DIR) && fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
      }

      res.json({ ok: true });
    } catch (error) {
      handleApiError(res, error, 'Failed to delete photo');
    }
  }
);

// PROJECT CLIENT COMMENTS & REPLIES (client, engineer, project_manager, super_admin)
app.get(
  '/api/projects/:id/comments',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const comments = await getProjectComments(
        req.cmsUser!,
        String(req.params.id)
      );
      res.json(comments);
    } catch (error) {
      handleApiError(res, error, 'Failed to load project comments');
    }
  }
);

app.post(
  '/api/projects/:id/comments',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await createProjectComment(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to post comment');
    }
  }
);

app.post(
  '/api/projects/:id/documents',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      const projectId = String(req.params.id);
      await assertProjectDuty(user, projectId, [
        'super_admin',
        'project_manager',
        'engineer',
      ]);

      const { title, url, kind } = req.body;
      if (!title || !url) {
        throw new BadRequestError('Document title and URL are required.');
      }

      const [doc] = await db
        .insert(cmsDocuments)
        .values({
          projectId,
          title: String(title).trim(),
          url: String(url).trim(),
          kind: kind || 'Drawing',
          uploadedBy: user.id,
        })
        .returning();

      res.status(201).json(doc);
    } catch (error) {
      handleApiError(res, error, 'Failed to add document');
    }
  }
);

// ROLE-SCOPED MODULE ENDPOINTS (Server-side per-project duty enforcement)
app.get(
  '/api/projects/:id/store',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'storekeeper',
        'project_manager',
      ]);
      const detail = await getProjectDetail(req.cmsUser!, projectId);
      res.json({
        materials: detail.materials,
        stockTransactions: detail.stockTransactions,
        materialRequests: detail.materialRequests,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to load store data');
    }
  }
);

app.get(
  '/api/projects/:id/workforce',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const { canSeeMoney } = await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'project_manager',
        'engineer',
        'foreman',
        'timekeeper',
      ]);
      const detail = await getProjectDetail(req.cmsUser!, projectId);
      res.json({
        workers: detail.workers,
        attendance: detail.attendance,
        payrollSummary: canSeeMoney ? detail.payrollSummary : undefined,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to load workforce data');
    }
  }
);

app.get(
  '/api/projects/:id/expenses',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'project_manager',
      ]);
      const detail = await getProjectDetail(req.cmsUser!, projectId);
      res.json({
        finance: detail.project.finance,
        expenses: detail.expenses,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to load expenses');
    }
  }
);

app.get(
  '/api/projects/:id/payments',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'project_manager',
      ]);
      const detail = await getProjectDetail(req.cmsUser!, projectId);
      res.json({
        payments: detail.payments,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to load payments');
    }
  }
);

app.get(
  '/api/projects/:id/finance',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'project_manager',
      ]);
      const detail = await getProjectDetail(req.cmsUser!, projectId);
      res.json({
        finance: detail.project.finance,
        expenses: detail.expenses,
        payments: detail.payments,
      });
    } catch (error) {
      handleApiError(res, error, 'Failed to load finance summary');
    }
  }
);

app.get(
  '/api/projects/:id/documents',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.params.id);
      await assertProjectDuty(req.cmsUser!, projectId, [
        'super_admin',
        'project_manager',
        'engineer',
      ]);
      const detail = await getProjectDetail(req.cmsUser!, projectId);
      res.json({ documents: detail.documents });
    } catch (error) {
      handleApiError(res, error, 'Failed to load documents');
    }
  }
);

// ADMIN GOVERNANCE (USERS, CLIENTS, SUPPLIERS, AUDIT LOGS)
app.get(
  '/api/admin/governance',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = await getAdminGovernanceData(req.cmsUser!);
      res.json(data);
    } catch (error) {
      handleApiError(res, error, 'Failed to load governance data');
    }
  }
);

app.post(
  '/api/admin/users',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      assertRole(req.cmsUser!, ['super_admin']);
      const { fullName, email, password, phone, role } = req.body;
      if (!fullName || !email || !role || !ALLOWED_PROJECT_ROLES.has(role as CmsRole)) {
        throw new BadRequestError('Full name, email, and valid role are required.');
      }
      if (!password || String(password).length < 6) {
        throw new BadRequestError('Password must be at least 6 characters.');
      }
      const normalizedEmail = String(email).trim().toLowerCase();

      const [created] = await db
        .insert(cmsUsers)
        .values({
          fullName: String(fullName).trim(),
          email: normalizedEmail,
          passwordHash: hashPassword(String(password)),
          phone: phone || null,
          role,
          status: 'active',
        })
        .returning();

      res.status(201).json(sanitizeUser(created));
    } catch (error) {
      handleApiError(res, error, 'Failed to create user');
    }
  }
);

app.patch(
  '/api/admin/users/:id',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      assertRole(req.cmsUser!, ['super_admin']);
      const { fullName, phone, role, status, password } = req.body;
      const patch: Partial<typeof cmsUsers.$inferInsert> = {};
      if (fullName !== undefined && String(fullName).trim()) {
        patch.fullName = String(fullName).trim();
      }
      if (phone !== undefined) patch.phone = phone || null;
      if (role !== undefined) {
        if (!ALLOWED_PROJECT_ROLES.has(role as CmsRole)) {
          throw new BadRequestError('Invalid role.');
        }
        patch.role = role;
      }
      if (status !== undefined) patch.status = status;
      if (password !== undefined && String(password).length > 0) {
        if (String(password).length < 6) {
          throw new BadRequestError('Password must be at least 6 characters.');
        }
        patch.passwordHash = hashPassword(String(password));
      }

      const [updated] = await db
        .update(cmsUsers)
        .set(patch)
        .where(eq(cmsUsers.id, String(req.params.id)))
        .returning();

      if (!updated) throw new NotFoundError('User not found.');
      res.json(sanitizeUser(updated));
    } catch (error) {
      handleApiError(res, error, 'Failed to update user');
    }
  }
);

app.patch(
  '/api/admin/users/:id/pin',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await setUserPinAdmin(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to set user PIN');
    }
  }
);

app.post(
  '/api/admin/clients',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      assertRole(req.cmsUser!, ['super_admin']);
      const { name, phone, email, address, userId } = req.body;
      if (!name) throw new BadRequestError('Client name is required.');

      const [client] = await db
        .insert(cmsClients)
        .values({
          name: String(name).trim(),
          phone: phone || null,
          email: email || null,
          address: address || null,
          userId: userId || null,
        })
        .returning();

      res.status(201).json(client);
    } catch (error) {
      handleApiError(res, error, 'Failed to create client');
    }
  }
);

app.post(
  '/api/suppliers',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = req.cmsUser!;
      let allowed = user.role === 'super_admin' || user.role === 'storekeeper';
      if (!allowed) {
        const roleMap = await getUserProjectRolesMap(user.id);
        for (const roles of roleMap.values()) {
          if (roles.includes('storekeeper')) {
            allowed = true;
            break;
          }
        }
      }
      if (!allowed) {
        throw new ForbiddenError('Only Super Admin or Storekeeper can add suppliers.');
      }

      const { name, phone, email } = req.body;
      if (!name) throw new BadRequestError('Supplier name is required.');

      const [supplier] = await db
        .insert(cmsSuppliers)
        .values({
          name: String(name).trim(),
          phone: phone || null,
          email: email || null,
        })
        .returning();

      res.status(201).json(supplier);
    } catch (error) {
      handleApiError(res, error, 'Failed to create supplier');
    }
  }
);

// ADMIN SITE SETTINGS (Super Admin only)
app.get(
  '/api/admin/site-settings',
  requireAuth,
  requireRole('super_admin'),
  async (_req: AuthRequest, res: Response) => {
    try {
      const settings = await getSiteSettings();
      res.json(settings);
    } catch (error) {
      handleApiError(res, error, 'Failed to load site settings');
    }
  }
);

const handleUpdateSiteSettings = async (req: AuthRequest, res: Response) => {
  try {
    const updated = await updateSiteSettings(req.cmsUser!, req.body || {});
    res.json(updated);
  } catch (error) {
    handleApiError(res, error, 'Failed to save site settings');
  }
};

app.put(
  '/api/admin/site-settings',
  requireAuth,
  requireRole('super_admin'),
  handleUpdateSiteSettings
);
app.patch(
  '/api/admin/site-settings',
  requireAuth,
  requireRole('super_admin'),
  handleUpdateSiteSettings
);

app.post(
  '/api/admin/site-settings/logo',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      assertRole(req.cmsUser!, ['super_admin']);
      const { fileName, mimeType, dataBase64 } = req.body || {};

      const ALLOWED_MIMES: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
      };
      const ext = ALLOWED_MIMES[String(mimeType || '').toLowerCase()];
      if (!ext) {
        throw new BadRequestError(
          'Unsupported logo format. Allowed: jpg, png, webp, svg.'
        );
      }

      const rawBase64 = String(dataBase64 || '').replace(
        /^data:[^;]+;base64,/,
        ''
      );
      if (!rawBase64) {
        throw new BadRequestError('Logo file content is required.');
      }

      let buffer = Buffer.from(rawBase64, 'base64');
      const MAX_BYTES = 2 * 1024 * 1024;
      if (buffer.length === 0 || buffer.length > MAX_BYTES) {
        throw new BadRequestError('Logo file must be between 1 byte and 2 MB.');
      }

      // Verify file signature / sanitize SVG
      if (ext === 'jpg') {
        if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
          throw new BadRequestError('Invalid JPEG file signature.');
        }
      } else if (ext === 'png') {
        if (
          buffer.length < 8 ||
          buffer[0] !== 0x89 ||
          buffer[1] !== 0x50 ||
          buffer[2] !== 0x4e ||
          buffer[3] !== 0x47
        ) {
          throw new BadRequestError('Invalid PNG file signature.');
        }
      } else if (ext === 'webp') {
        if (
          buffer.length < 12 ||
          buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
          buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
        ) {
          throw new BadRequestError('Invalid WebP file signature.');
        }
      } else if (ext === 'svg') {
        const svgText = buffer.toString('utf8');
        if (!/<svg[\s>]/i.test(svgText)) {
          throw new BadRequestError('Invalid SVG file.');
        }
        const cleanedSvg = svgText
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
          .replace(/javascript:/gi, '');
        buffer = Buffer.from(cleanedSvg, 'utf8');
      }

      const safeBaseName = String(fileName || 'logo')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 24) || 'logo';
      const objectName = `logos/${safeBaseName}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

      let publicUrl = `/uploads/${objectName}`;
      // Attempt GCS public storage bucket if provisioned; otherwise store in Express public bucket (/uploads)
      try {
        if (firebaseConfig.storageBucket) {
          const bucket = getStorage().bucket(firebaseConfig.storageBucket);
          const [exists] = await bucket.exists();
          if (exists) {
            const file = bucket.file(objectName);
            await file.save(buffer, {
              contentType: mimeType,
              public: true,
              metadata: { cacheControl: 'public, max-age=31536000' },
            });
            publicUrl = `https://storage.googleapis.com/${firebaseConfig.storageBucket}/${objectName}`;
          } else {
            fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
          }
        } else {
          fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
        }
      } catch {
        fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, objectName), buffer);
      }

      const updated = await updateSiteSettings(req.cmsUser!, {
        logoUrl: publicUrl,
      });

      res.status(201).json({ url: publicUrl, settings: updated });
    } catch (error) {
      handleApiError(res, error, 'Failed to upload logo');
    }
  }
);

// ============================================================
// EXCEL / CSV TEMPLATES, EXPORTS, AND TRANSACTIONAL IMPORTS
// ============================================================
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

app.get(
  '/api/excel/workers/template',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      const projectName = req.query.projectName
        ? String(req.query.projectName)
        : null;
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await generateWorkersTemplate(
        req.cmsUser!,
        projectId,
        projectName,
        lang
      );
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="workers-template.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to generate workers template');
    }
  }
);

app.get(
  '/api/excel/workers/export',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await exportWorkersWorkbook(req.cmsUser!, projectId, lang);
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="workers-export.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to export workers');
    }
  }
);

app.post(
  '/api/excel/workers/preview',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { fileName, dataBase64, defaultProjectId, pendingProjectName } =
        req.body || {};
      const result = await previewWorkersImport(req.cmsUser!, {
        fileName: String(fileName || ''),
        dataBase64: String(dataBase64 || ''),
        defaultProjectId: defaultProjectId ? String(defaultProjectId) : null,
        pendingProjectName: pendingProjectName
          ? String(pendingProjectName)
          : null,
      });
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to preview workers import');
    }
  }
);

app.post(
  '/api/excel/workers/import',
  requireAuth,
  requireRole('super_admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { fileName, dataBase64, defaultProjectId, duplicateStrategy } =
        req.body || {};
      const result = await commitWorkersImport(req.cmsUser!, {
        fileName: String(fileName || ''),
        dataBase64: String(dataBase64 || ''),
        defaultProjectId: defaultProjectId ? String(defaultProjectId) : null,
        duplicateStrategy: duplicateStrategy === 'update' ? 'update' : 'skip',
      });
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to import workers');
    }
  }
);

app.get(
  '/api/excel/materials/template',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await generateMaterialsTemplate(req.cmsUser!, projectId, lang);
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="materials-template.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to generate materials template');
    }
  }
);

app.get(
  '/api/excel/materials/export',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await exportMaterialsWorkbook(req.cmsUser!, projectId, lang);
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="materials-export.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to export materials');
    }
  }
);

app.post(
  '/api/excel/materials/preview',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { fileName, dataBase64, defaultProjectId } = req.body || {};
      const result = await previewMaterialsImport(req.cmsUser!, {
        fileName: String(fileName || ''),
        dataBase64: String(dataBase64 || ''),
        defaultProjectId: defaultProjectId ? String(defaultProjectId) : null,
      });
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to preview materials import');
    }
  }
);

app.post(
  '/api/excel/materials/import',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { fileName, dataBase64, defaultProjectId, duplicateStrategy } =
        req.body || {};
      const result = await commitMaterialsImport(req.cmsUser!, {
        fileName: String(fileName || ''),
        dataBase64: String(dataBase64 || ''),
        defaultProjectId: defaultProjectId ? String(defaultProjectId) : null,
        duplicateStrategy: duplicateStrategy === 'update' ? 'update' : 'skip',
      });
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to import materials');
    }
  }
);

// MATERIAL REQUEST EXCEL GRID (Template, Parse Import, Export Draft / Submitted)
app.get(
  '/api/excel/material-requests/template',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.query.projectId || '').trim();
      if (!projectId) {
        throw new BadRequestError('Project ID is required.');
      }
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await generateMaterialRequestTemplate(
        req.cmsUser!,
        projectId,
        lang
      );
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="material-request-template.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to generate material request template');
    }
  }
);

app.post(
  '/api/excel/material-requests/parse',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { projectId, fileName, dataBase64 } = req.body || {};
      const parsed = await parseMaterialRequestSpreadsheet(req.cmsUser!, {
        projectId: String(projectId || ''),
        fileName: String(fileName || ''),
        dataBase64: String(dataBase64 || ''),
      });
      res.json(parsed);
    } catch (error) {
      handleApiError(res, error, 'Failed to parse material request spreadsheet');
    }
  }
);

app.post(
  '/api/excel/material-requests/export',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { projectId, rows, lang } = req.body || {};
      const buf = await exportMaterialRequestGridWorkbook(req.cmsUser!, {
        projectId: String(projectId || ''),
        lang,
        rows: Array.isArray(rows) ? rows : [],
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="material-request-grid.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to export material request grid');
    }
  }
);

app.get(
  '/api/excel/material-requests/:requestId/export',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await exportSubmittedMaterialRequestWorkbook(
        req.cmsUser!,
        String(req.params.requestId),
        lang
      );
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="material-request.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to export material request');
    }
  }
);

// DAILY ATTENDANCE EXCEL (Template, Parse Import, Export)
app.get(
  '/api/excel/attendance/template',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.query.projectId || '').trim();
      if (!projectId) {
        throw new BadRequestError('Project ID is required.');
      }
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await generateAttendanceTemplate(req.cmsUser!, projectId, lang);
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="daily-attendance-template.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to generate attendance template');
    }
  }
);

app.post(
  '/api/excel/attendance/parse',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { projectId, fileName, dataBase64 } = req.body || {};
      const parsed = await parseAttendanceSpreadsheet(req.cmsUser!, {
        projectId: String(projectId || ''),
        fileName: String(fileName || ''),
        dataBase64: String(dataBase64 || ''),
      });
      res.json(parsed);
    } catch (error) {
      handleApiError(res, error, 'Failed to parse attendance spreadsheet');
    }
  }
);

app.get(
  '/api/excel/attendance/export',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const projectId = String(req.query.projectId || '').trim();
      if (!projectId) {
        throw new BadRequestError('Project ID is required.');
      }
      const workDate = req.query.workDate ? String(req.query.workDate) : null;
      const lang = req.query.lang ? String(req.query.lang) : undefined;
      const buf = await exportAttendanceWorkbook(req.cmsUser!, {
        projectId,
        workDate,
        lang,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="daily-attendance-export.xlsx"'
      );
      res.send(buf);
    } catch (error) {
      handleApiError(res, error, 'Failed to export attendance');
    }
  }
);

// ============================================================
// BRANDED DOCUMENT EXPORTS (A4 PDF & EXCEL WITH COMPANY + PROJECT BRANDING)
// ============================================================
app.get(
  '/api/projects/:id/documents/material-request/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportMaterialRequestPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        requestId: req.query.requestId ? String(req.query.requestId) : null,
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export material request PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/stock-sheet/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportStockSheetPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export stock sheet PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/stock-sheet/xlsx',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportStockSheetWorkbook(req.cmsUser!, {
        projectId: String(req.params.id),
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export stock sheet Excel');
    }
  }
);

app.get(
  '/api/projects/:id/documents/purchase-receiving/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportPurchaseReceivingPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        transactionId: req.query.transactionId
          ? String(req.query.transactionId)
          : null,
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export purchase receiving PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/purchase-receiving/xlsx',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportPurchaseReceivingWorkbook(req.cmsUser!, {
        projectId: String(req.params.id),
        transactionId: req.query.transactionId
          ? String(req.query.transactionId)
          : null,
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export purchase receiving Excel');
    }
  }
);

app.get(
  '/api/projects/:id/documents/workers-daily-sheet/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportWorkersDailySheetPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        workDate: req.query.workDate ? String(req.query.workDate) : null,
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export workers daily sheet PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/daily-costs/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportDailyCostsPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export daily costs PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/daily-costs/xlsx',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportDailyCostsWorkbook(req.cmsUser!, {
        projectId: String(req.params.id),
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export daily costs Excel');
    }
  }
);

app.get(
  '/api/projects/:id/documents/progress-report/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportProgressReportPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        reportId: req.query.reportId ? String(req.query.reportId) : null,
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export progress report PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/progress-report/xlsx',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportProgressReportWorkbook(req.cmsUser!, {
        projectId: String(req.params.id),
        reportId: req.query.reportId ? String(req.query.reportId) : null,
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export progress report Excel');
    }
  }
);

// ============================================================
// QUALITY CONTROL & TOPOGRAPHIC SURVEY ROUTES
// ============================================================
app.get(
  '/api/projects/:id/qc-tests',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const rows = await listQcTests(req.cmsUser!, String(req.params.id));
      res.json({ tests: rows });
    } catch (error) {
      handleApiError(res, error, 'Failed to load quality control tests');
    }
  }
);

app.post(
  '/api/projects/:id/qc-tests',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await createQcTest(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to record quality control test');
    }
  }
);

app.patch(
  '/api/qc-tests/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await updateQcTest(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update quality control test');
    }
  }
);

app.delete(
  '/api/qc-tests/:id',
  requireAuth,
  async (_req: AuthRequest, res: Response) => {
    handleApiError(
      res,
      new ForbiddenError('Quality control test results cannot be deleted.'),
      'Quality control test results cannot be deleted.'
    );
  }
);

app.get(
  '/api/qc-tests/:id/history',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const history = await getQcTestHistory(req.cmsUser!, String(req.params.id));
      res.json({ history });
    } catch (error) {
      handleApiError(res, error, 'Failed to load QC test history');
    }
  }
);

app.get(
  '/api/projects/:id/documents/qc-register/pdf',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportQcRegisterPdf(req.cmsUser!, {
        projectId: String(req.params.id),
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export QC register PDF');
    }
  }
);

app.get(
  '/api/projects/:id/documents/qc-register/xlsx',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await exportQcRegisterWorkbook(req.cmsUser!, {
        projectId: String(req.params.id),
        lang: req.query.lang,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.fileName}"`
      );
      res.send(result.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export QC register Excel');
    }
  }
);

app.get(
  '/api/projects/:id/survey-records',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const records = await listSurveyRecords(req.cmsUser!, String(req.params.id));
      res.json({ records });
    } catch (error) {
      handleApiError(res, error, 'Failed to load survey records');
    }
  }
);

app.post(
  '/api/projects/:id/survey-records',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const created = await createSurveyRecord(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.status(201).json(created);
    } catch (error) {
      handleApiError(res, error, 'Failed to create survey record');
    }
  }
);

app.patch(
  '/api/survey-records/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await updateSurveyRecord(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update survey record');
    }
  }
);

app.get(
  '/api/projects/:id/qc-survey-attachments/:recordType/:recordId/:attId',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const recordType = String(req.params.recordType);
      if (recordType !== 'qc' && recordType !== 'survey') {
        throw new BadRequestError('Invalid attachment record type.');
      }
      const file = await getAuthorizedQcSurveyAttachment(
        req.cmsUser!,
        String(req.params.id),
        recordType,
        String(req.params.recordId),
        String(req.params.attId)
      );
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.name.replace(/"/g, '')}"`
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(file.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to download attachment');
    }
  }
);

// ============================================================
// MASTER MATERIAL CATALOG (Super Admin & Storekeeper manage; requestors select)
// ============================================================
app.get('/api/catalog', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await listCatalogItems(req.cmsUser!, {
      search: req.query.search ? String(req.query.search) : undefined,
      category: req.query.category ? String(req.query.category) : undefined,
      type: req.query.type ? String(req.query.type) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      needsReview: req.query.needsReview === 'true' || req.query.needsReview === '1',
    });
    res.json(result);
  } catch (error) {
    handleApiError(res, error, 'Failed to load master material catalog');
  }
});

app.get(
  '/api/catalog/selectable',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await getSelectableCatalogItems(req.cmsUser!);
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to load selectable catalog items');
    }
  }
);

app.post('/api/catalog', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const created = await addCatalogItem(req.cmsUser!, req.body || {});
    res.status(201).json(created);
  } catch (error) {
    handleApiError(res, error, 'Failed to add catalog item');
  }
});

app.patch(
  '/api/catalog/:id',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const updated = await updateCatalogItem(
        req.cmsUser!,
        String(req.params.id),
        req.body || {}
      );
      res.json(updated);
    } catch (error) {
      handleApiError(res, error, 'Failed to update catalog item');
    }
  }
);

app.post(
  '/api/catalog/merge',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { sourceId, targetId } = req.body || {};
      const result = await mergeCatalogItems(
        req.cmsUser!,
        String(sourceId || ''),
        String(targetId || '')
      );
      res.json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to merge catalog items');
    }
  }
);

app.post(
  '/api/catalog/import',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await importCatalogData(req.cmsUser!, req.body || {});
      res.status(201).json(result);
    } catch (error) {
      handleApiError(res, error, 'Failed to import master material catalog');
    }
  }
);

app.get(
  '/api/catalog/export',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
      const file = await exportCatalogFile(req.cmsUser!, format);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName}"`
      );
      res.send(file.buffer);
    } catch (error) {
      handleApiError(res, error, 'Failed to export master material catalog');
    }
  }
);

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

registerApiNotFound(app);

// Any error thrown outside a route's own try/catch (bad JSON body, payload too
// large, ...) must still answer JSON for /api, never an HTML error page.
app.use(
  (err: any, req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (!req.originalUrl.startsWith('/api')) return next(err);
    const status =
      Number(err?.status || err?.statusCode) >= 400 &&
      Number(err?.status || err?.statusCode) < 600
        ? Number(err.status || err.statusCode)
        : 500;
    console.error('Unhandled API error:', err);
    res.status(status).json({
      error:
        status === 413
          ? 'Request body is too large.'
          : status === 400
          ? 'Malformed request body.'
          : 'Internal server error',
    });
  }
);

// A single failed promise (e.g. database briefly unreachable) must not kill the server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

function resolveListenPort(): number {
  const portArgIdx = process.argv.findIndex((a) => a === '--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const parsedArg = Number(process.argv[portArgIdx + 1]);
    if (Number.isFinite(parsedArg) && parsedArg > 0) return parsedArg;
  }
  const portEqArg = process.argv.find((a) => a.startsWith('--port='));
  if (portEqArg) {
    const parsedArg = Number(portEqArg.split('=')[1]);
    if (Number.isFinite(parsedArg) && parsedArg > 0) return parsedArg;
  }
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  if (
    process.env.NODE_ENV !== 'production' &&
    Number.isFinite(envPort) &&
    Number.isFinite(nginxPort) &&
    envPort === nginxPort
  ) {
    return Number(process.env.DEFAULT_APP_PORT) || 3000;
  }
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}

async function startServer() {
  const PORT = resolveListenPort();
  const disableHmr = process.env.DISABLE_HMR === 'true';

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(disableHmr ? { hmr: false, ws: false } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Operations CMS server listening on port ${PORT}`);
  });
  server.on('error', (err) => {
    console.error(`Failed to bind server on port ${PORT}:`, err);
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

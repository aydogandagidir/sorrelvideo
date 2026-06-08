import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import templatesRouter from "./templates";
import projectsRouter from "./projects";
import brandRouter from "./brand";
import modulesRouter from "./modules";
import statsRouter from "./stats";
import analyticsRouter from "./analytics";
import billingRouter from "./billing";
import storageRouter from "./storage";
import aiRouter from "./ai";
import compositionsRouter from "./compositions";
import studioRouter from "./studio";
import websiteToVideoRouter from "./websiteToVideo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(templatesRouter);
router.use(projectsRouter);
router.use(brandRouter);
router.use(modulesRouter);
router.use(statsRouter);
router.use(analyticsRouter);
router.use(billingRouter);
router.use(storageRouter);
router.use(aiRouter);
router.use(compositionsRouter);
router.use(studioRouter);
router.use(websiteToVideoRouter);

export default router;

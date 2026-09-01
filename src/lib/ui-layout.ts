import { z } from "zod";

export const DEFAULT_TODAY_MAX_WIDTH_PX = 960;
export const MIN_TODAY_MAX_WIDTH_PX = 680;
export const MAX_TODAY_MAX_WIDTH_PX = 1200;
export const EXPANDED_SIDEBAR_WIDTH_PX = 260;

export const todayMaxWidthPxSchema = z
	.number()
	.int()
	.min(MIN_TODAY_MAX_WIDTH_PX)
	.max(MAX_TODAY_MAX_WIDTH_PX);

export const todayUiConfigSchema = z.object({
	todayMaxWidthPx: todayMaxWidthPxSchema,
});

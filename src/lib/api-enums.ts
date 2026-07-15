import { z } from "zod";

export const resourceKindSchema = z.enum([
	"home",
	"mentions",
	"authored",
	"search",
	"dms",
]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const inboxKindSchema = z.enum(["mixed", "mentions", "dms"]);
export type InboxKind = z.infer<typeof inboxKindSchema>;

export const dmDirectionSchema = z.enum(["inbound", "outbound"]);

export const timelineCollectionKindSchema = z.enum(["likes", "bookmarks"]);
export type TimelineCollectionKind = z.infer<
	typeof timelineCollectionKindSchema
>;

export const followDirectionSchema = z.enum(["followers", "following"]);
export type FollowDirection = z.infer<typeof followDirectionSchema>;

export const webSyncKindSchema = z.enum([
	"timeline",
	"mentions",
	"likes",
	"bookmarks",
	"dms",
	"following",
]);
export type WebSyncKind = z.infer<typeof webSyncKindSchema>;

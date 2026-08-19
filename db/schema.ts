import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const onlineRooms = sqliteTable("online_rooms", {
  code: text("code").primaryKey(),
  state: text("state").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

export const onlinePresence = sqliteTable("online_presence", {
  roomCode: text("room_code").notNull(),
  playerId: text("player_id").notNull(),
  lastSeen: integer("last_seen").notNull(),
}, (table) => [primaryKey({ columns: [table.roomCode, table.playerId] })]);

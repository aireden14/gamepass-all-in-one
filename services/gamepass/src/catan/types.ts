// Catan engine — types only, no I/O, no Prisma.

export type Resource = "brick" | "wood" | "sheep" | "wheat" | "ore";
export const RESOURCES: Resource[] = ["brick", "wood", "sheep", "wheat", "ore"];

export type Terrain = Resource | "desert";

export type DevCardType =
  | "knight"
  | "vp"
  | "road_building"
  | "year_of_plenty"
  | "monopoly";

export type PortKind = "any" | Resource; // "any" = 3:1, resource = 2:1

export type Phase =
  | "SETUP_R1_SETTLEMENT"
  | "SETUP_R1_ROAD"
  | "SETUP_R2_SETTLEMENT"
  | "SETUP_R2_ROAD"
  | "MAIN_ROLL"
  | "MAIN_DISCARD"   // ожидание сброса картами от тех, у кого >7
  | "MAIN_ROBBER"    // двигаем разбойника после 7 или knight
  | "MAIN_TURN"      // build / trade / dev / end
  | "GAME_OVER";

export interface Hex {
  q: number;
  r: number;
  terrain: Terrain;
  token: number | null; // 2..12 без 7; null у desert
}

export interface Port {
  edge: string;
  kind: PortKind;
  vertices: [string, string]; // вершины, которые видят порт
}

export interface Board {
  hexes: Hex[];
  hexById: Record<string, Hex>;       // "q,r" -> hex
  vertices: string[];                  // все уникальные ключи
  edges: string[];                     // все уникальные ключи
  vertexNeighbors: Record<string, string[]>; // вершина -> соседние вершины
  vertexEdges: Record<string, string[]>;     // вершина -> инцидентные рёбра
  edgeVertices: Record<string, [string, string]>;
  vertexHexes: Record<string, string[]>;     // вершина -> ID гексов
  hexVertices: Record<string, string[]>;     // гекс -> 6 вершин
  hexEdges: Record<string, string[]>;        // гекс -> 6 рёбер
  ports: Port[];
  robberHex: string;                          // ID гекса с разбойником (изначально desert)
}

export type ResourceBag = Partial<Record<Resource, number>>;

export interface PlayerState {
  seat: number;
  color: string;
  resources: Record<Resource, number>;
  devCards: Record<DevCardType, number>;     // в руке (можно играть, кроме купленных в этом ходу)
  newDevCards: Record<DevCardType, number>;  // куплены в этом ходу (нельзя играть)
  playedKnights: number;
  settlements: string[];                      // vertex IDs
  cities: string[];                            // vertex IDs (переехавшие из settlements)
  roads: string[];                             // edge IDs
  hasLongestRoad: boolean;
  hasLargestArmy: boolean;
  victoryPointsHidden: number;                 // из VP-карт
}

export interface PendingTrade {
  id: string;
  fromSeat: number;
  give: ResourceBag;
  receive: ResourceBag;
  toSeats: number[]; // потенциальные принимающие
  acceptedBy: number[];
}

export interface LogEntry {
  t: number;          // timestamp (ms)
  seat?: number;
  kind: string;       // "ROLL" | "BUILD_SETTLEMENT" | ... | "ROBBED"
  data?: any;
}

export interface GameState {
  phase: Phase;
  currentSeat: number;
  numPlayers: number;
  targetVP: number;

  players: PlayerState[];

  dice: [number, number] | null;
  lastRoll: number | null;

  // discard / robber
  mustDiscard: Record<number, number>;        // seat -> сколько ещё надо сбросить

  // dev deck remaining counts
  devDeck: Record<DevCardType, number>;

  // road / army leaders
  longestRoadOwner: number | null;            // seat
  longestRoadLen: number;                      // длина текущего лидера (>=5)
  largestArmyOwner: number | null;
  largestArmySize: number;                     // >=3

  // bonuses already awarded?
  longestRoadAwarded: boolean;
  largestArmyAwarded: boolean;

  // per-turn flags
  hasRolled: boolean;
  hasPlayedDevCardThisTurn: boolean;

  // free-build счётчики (Road Building, и второй road в SETUP)
  freeRoadsRemaining: number;

  pendingTrades: PendingTrade[];

  winnerSeat: number | null;
  log: LogEntry[];
}

export type CatanAction =
  | { type: "ROLL_DICE" }
  | { type: "BUILD_SETTLEMENT"; vertex: string }
  | { type: "BUILD_CITY"; vertex: string }
  | { type: "BUILD_ROAD"; edge: string }
  | { type: "BUY_DEV_CARD" }
  | { type: "PLAY_KNIGHT"; toHex: string; stealFrom: number | null }
  | { type: "PLAY_ROAD_BUILDING"; edges: [string] | [string, string] }
  | { type: "PLAY_YEAR_OF_PLENTY"; resources: [Resource] | [Resource, Resource] }
  | { type: "PLAY_MONOPOLY"; resource: Resource }
  | { type: "MOVE_ROBBER"; toHex: string; stealFrom: number | null }
  | { type: "DISCARD"; resources: ResourceBag }
  | { type: "BANK_TRADE"; give: Resource; receive: Resource }
  | { type: "OFFER_TRADE"; give: ResourceBag; receive: ResourceBag; to?: number[] }
  | { type: "ACCEPT_TRADE"; offerId: string; bySeat: number }
  | { type: "CONFIRM_TRADE"; offerId: string; withSeat: number }
  | { type: "CANCEL_TRADE"; offerId: string }
  | { type: "END_TURN" };

export type EventKind =
  | "ROLL" | "PRODUCE" | "DISCARD" | "ROBBER_MOVED" | "STOLEN"
  | "BUILD_SETTLEMENT" | "BUILD_CITY" | "BUILD_ROAD"
  | "BUY_DEV" | "PLAY_DEV"
  | "BANK_TRADE" | "TRADE_OFFER" | "TRADE_CONFIRMED" | "TRADE_CANCELLED"
  | "LONGEST_ROAD" | "LARGEST_ARMY"
  | "END_TURN" | "GAME_OVER";

export interface CatanEvent {
  kind: EventKind;
  seat?: number;
  data?: any;
}

export class IllegalActionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "IllegalActionError";
  }
}

export interface CatanSettings {
  targetVP?: number;          // default 10
  withBots?: boolean;
  botDifficulties?: Record<number, "easy" | "medium" | "hard">; // seat -> level
}

// Стоимости построек
export const COST_ROAD: ResourceBag = { brick: 1, wood: 1 };
export const COST_SETTLEMENT: ResourceBag = { brick: 1, wood: 1, sheep: 1, wheat: 1 };
export const COST_CITY: ResourceBag = { ore: 3, wheat: 2 };
export const COST_DEV: ResourceBag = { sheep: 1, wheat: 1, ore: 1 };

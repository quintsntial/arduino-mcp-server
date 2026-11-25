import boardReferenceData from "../data/board-reference.json" with { type: "json" };

export interface BoardPin {
  name: string;
  capabilities?: string[];
}

export interface BoardReference {
  id: string;
  displayName: string;
  aliases: string[];
  fqbnCandidates: string[];
  mcu: string;
  logicVoltage: string;
  operatingVoltage: string;
  digitalPins: BoardPin[];
  analogPins: BoardPin[];
  pwmPins: string[];
  i2c?: {
    sda?: string;
    scl?: string;
  };
  spi?: {
    miso?: string;
    mosi?: string;
    sck?: string;
    ss?: string;
  };
  uart?: {
    hardware?: string[];
    conditionalNote?: string;
  };
  notes: string[];
  referenceLinks: string[];
}

interface BoardReferenceStore {
  version: string;
  boards: BoardReference[];
}

const store = boardReferenceData as BoardReferenceStore;

export function listBoardReferences(): BoardReference[] {
  return store.boards;
}

export function getBoardReferenceById(id: string): BoardReference | null {
  const normalized = id.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return store.boards.find((board) => board.id.toLowerCase() === normalized) ?? null;
}

export function findBoardReferenceByFqbn(fqbn: string): BoardReference | null {
  const normalized = fqbn.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const matchExact = (target: string) =>
    store.boards.find((board) =>
      board.fqbnCandidates.some((candidate) => candidate.toLowerCase() === target)
    ) ?? null;

  // An FQBN may carry board menu options after the third segment, e.g.
  // "arduino:avr:nano:cpu=atmega328old". The reference lists base FQBNs, so fall back to
  // "vendor:arch:board" when the full string has no exact match.
  return matchExact(normalized) ?? matchExact(baseFqbn(normalized));
}

/** "vendor:arch:board[:menu=opt,...]" -> "vendor:arch:board" */
export function baseFqbn(fqbn: string): string {
  return fqbn.trim().split(":").slice(0, 3).join(":");
}

export function findBoardReference(query: string): BoardReference[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return store.boards.filter((board) => {
    if (board.id.toLowerCase().includes(normalized)) {
      return true;
    }

    if (board.displayName.toLowerCase().includes(normalized)) {
      return true;
    }

    if (board.aliases.some((alias) => alias.toLowerCase().includes(normalized))) {
      return true;
    }

    if (board.fqbnCandidates.some((fqbn) => fqbn.toLowerCase().includes(normalized))) {
      return true;
    }

    return false;
  });
}

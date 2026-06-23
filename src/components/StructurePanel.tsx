import type * as zarr from "zarrita";
import { asConsolidated, asIcechunk, type IcechunkInfo } from "../zarr/load-zarr";
import type {
  CodecSummary,
  GeoZarrMetadataSource,
  StructureProfileSummary,
} from "../zarr/structure";
import type {
  PanelState,
  ViewerState,
  ViewerStateUpdate,
} from "../state/types";
import { InfoIcon } from "./Tooltip";

/** Top-level keys we render with their canonical labels under GeoZarr.
 * Any *other* top-level key in the metadata is dumped to a generic
 * key/value list below — that's how AEF's `geoemb:*` and future
 * extension keys surface without special-casing. */
const GEOZARR_KEYS = [
  "spatial:dimensions",
  "spatial:transform",
  "spatial:shape",
  "spatial:bbox",
  "proj:code",
] as const;

const METADATA_SOURCE_DESC: Record<GeoZarrMetadataSource, string> = {
  "store-native": "GeoZarr attrs read directly from the store.",
  injected:
    "Store had no GeoZarr attrs; the viewer passes a hand-built constant for ZarrLayer.metadata.",
  synthesized:
    "Store had no GeoZarr attrs; the viewer built them from the store's coord arrays at load time.",
};

type Props = {
  state: ViewerState;
  update: (patch: ViewerStateUpdate) => void;
  /** Opened root group — used to detect consolidated metadata. */
  group: zarr.Group<zarr.Readable>;
  /** Active variable array (or group, for whole-group renderers).
   * `null` while still resolving. */
  node:
    | zarr.Array<zarr.DataType, zarr.Readable>
    | zarr.Group<zarr.Readable>
    | null;
  /** Profile-supplied summary. */
  structure: StructureProfileSummary;
  /** Codec/sharding info fetched on the side; `null` while pending or on
   * failure. */
  codecs: CodecSummary | null;
  /** False for non-geographic (image) hosts — hides the GeoZarr metadata
   * section, which is map-only. Defaults to shown when omitted. */
  geographic?: boolean;
};

/** Always-visible orientation block at the top of the Options panel: the
 * store's identity (URL / format) and a compact dimensions table pairing each
 * dimension's shape with its chunk size. Sits above the Data controls. */
export function ArrayOverview({
  state,
  group,
  structure,
  node,
}: {
  state: ViewerState;
  group: zarr.Group<zarr.Readable>;
  structure: StructureProfileSummary;
  node: Props["node"];
}) {
  const icechunk = asIcechunk(group.store);
  const consolidated = asConsolidated(group.store) !== null;
  return (
    <>
      <StoreSection
        url={state.url}
        zarrVersion={structure.zarrVersion}
        consolidated={consolidated}
        icechunk={icechunk}
      />
      <DimensionsTable node={node} />
    </>
  );
}

/** Store-introspection content, rendered as a collapsible section inside the
 * Options panel (below "View"). Open/closed state is mirrored to the URL via
 * `panelStructure` (the `?structure=` param). */
export function StructureSection({
  state,
  update,
  node,
  structure,
  codecs,
  geographic = true,
}: Props) {
  const isOpen = state.panelStructure === "open";
  return (
    <details
      className="section"
      open={isOpen}
      onToggle={(e) =>
        update({
          panelStructure: (e.target as HTMLDetailsElement).open
            ? ("open" as PanelState)
            : ("closed" as PanelState),
        })
      }
    >
      <summary>
        <span className="section-title">Structure</span>
        <span
          className="mono"
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            textTransform: "none",
            marginLeft: 8,
          }}
        >
          Zarr {structure.zarrVersion}
        </span>
      </summary>

      <div className="section-body">
        <VariableSection structure={structure} node={node} />
        <ShardingSection codecs={codecs} />
        {geographic && <GeoZarrSection structure={structure} />}
        <AttributesSection node={node} />
      </div>
    </details>
  );
}

/** Compact table pairing each dimension's shape with its chunk length. Replaces
 * the standalone Shape / Chunks rows that used to live in the Variable section.
 * Rows are dimensions so the table stays narrow regardless of rank. */
function DimensionsTable({ node }: { node: Props["node"] }) {
  const arr = node && "kind" in node && node.kind === "array" ? node : null;
  return (
    <div className="section">
      <span className="section-title">Dimensions</span>
      {arr ? (
        <table className="dim-table">
          <thead>
            <tr>
              <th>Dim</th>
              <th>Shape</th>
              <th>Chunks</th>
            </tr>
          </thead>
          <tbody>
            {arr.shape.map((s, i) => {
              const name = arr.dimensionNames?.[i] ?? `dim ${i}`;
              return (
                <tr key={`${name}-${i}`}>
                  <td>{name}</td>
                  <td className="mono">{s}</td>
                  <td className="mono">{arr.chunks[i]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <span className="meta-muted" style={{ marginTop: 6 }}>
          —
        </span>
      )}
    </div>
  );
}

function StoreSection({
  url,
  zarrVersion,
  consolidated,
  icechunk,
}: {
  url: string | null;
  zarrVersion: "v2" | "v3";
  consolidated: boolean;
  icechunk: IcechunkInfo | null;
}) {
  return (
    <div className="section">
      <span className="section-title">Store</span>
      <dl className="meta-kv" style={{ marginTop: 6 }}>
        <KV label="URL">
          <span style={{ wordBreak: "break-all" }}>{url ?? "—"}</span>
        </KV>
        <KV
          label="Format"
          info={
            icechunk
              ? "Icechunk is a transactional storage format layered over Zarr v3: a snapshot pins every array's metadata and chunk locations, so the data you see is one immutable version of the repo. The viewer reads it with icechunk-js instead of plain HTTP."
              : "The on-disk Zarr format version. v2 uses one metadata file per node (.zarray / .zgroup / .zattrs); v3 stores them in a single zarr.json per node and adds first-class sharding for many-small-chunk stores. This viewer opens every store with zarr.open.v3 today, so all current examples are v3."
          }
        >
          {icechunk ? `Icechunk ${icechunk.specVersion} · Zarr ${zarrVersion}` : `Zarr ${zarrVersion}`}
        </KV>
        {icechunk ? (
          <IcechunkRows icechunk={icechunk} />
        ) : (
          <KV
            label="Consolidated"
            info="Whether the store ships a pre-built 'table of contents' that lists every node's metadata in one file. With consolidated metadata, the client opens sub-arrays without an extra HTTP request — important for stores with many variables. Without it, every zarr.open() of a sub-array is its own round trip."
          >
            <YesNoPill value={consolidated} />
          </KV>
        )}
      </dl>
    </div>
  );
}

function IcechunkRows({ icechunk }: { icechunk: IcechunkInfo }) {
  // Snapshot IDs are 20-char Base32; show a short prefix with the full id on
  // hover, plus the commit message and flush time as muted sub-lines.
  const shortId = icechunk.snapshotId.slice(0, 8);
  return (
    <>
      <KV
        label="Branch"
        info="The Icechunk branch the viewer checked out (always the latest snapshot on that branch). The viewer reads the default branch; switching branches isn't supported here."
      >
        {icechunk.branch}
      </KV>
      <KV
        label="Snapshot"
        info={`Immutable snapshot ${icechunk.snapshotId} — the exact repo version being read.`}
      >
        <div style={{ display: "grid", gap: 2 }}>
          <span className="mono" title={icechunk.snapshotId}>
            {shortId}…
          </span>
          {icechunk.message && (
            <span className="meta-muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
              {formatJson(icechunk.message)}
            </span>
          )}
          <span className="meta-muted" style={{ fontSize: 11 }}>
            {formatFlushedAt(icechunk.flushedAt)}
          </span>
        </div>
      </KV>
      <KV
        label="Branches"
        info="Other branches in the repo. Empty for v1 Icechunk stores read over plain HTTP — the proxy can't list refs, so only the checked-out branch is known."
      >
        {icechunk.branches.length > 0 ? icechunk.branches.join(", ") : "(none listed)"}
      </KV>
      <KV label="Tags">
        {icechunk.tags.length > 0 ? icechunk.tags.join(", ") : "(none listed)"}
      </KV>
    </>
  );
}

function formatFlushedAt(d: Date): string {
  const t = d.getTime();
  if (!Number.isFinite(t)) return "—";
  // Trim milliseconds: "2026-01-20T11:28:33Z".
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

function YesNoPill({ value }: { value: boolean }) {
  // Green pill for "yes", amber pill for "no" — same visual language as
  // the GeoZarr metadata-source badge in the GeoZarr section.
  const bg = value ? "#1f6b3a" : "#a06a10";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 3,
        background: bg,
        color: "#fff",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {value ? "yes" : "no"}
    </span>
  );
}

function VariableSection({
  structure,
  node,
}: {
  structure: StructureProfileSummary;
  node: Props["node"];
}) {
  // `Path` is intentionally omitted — the active variable is already named by
  // the Data controls above, so repeating it here is redundant. Shape/Chunks
  // moved to the DimensionsTable in the overview block.
  const [, ...rest] = structure.variables;
  const arr = node && "kind" in node && node.kind === "array" ? node : null;
  const chunks = arr ? arr.chunks : null;
  const dtype = arr ? arr.dtype : null;
  const fillValue = arr ? formatFillValue(arr.fillValue) : null;
  return (
    <div className="section">
      <span className="section-title">Variable</span>
      <dl className="meta-kv" style={{ marginTop: 6 }}>
        <KV
          label="Chunk size"
          info="Estimated uncompressed size of one chunk = product of the chunk dimensions × the dtype's byte width. This is the data a client must decode (and hold in memory) to read any element in the chunk; the bytes actually stored/transferred are smaller after compression."
        >
          {formatChunkBytes(chunks, dtype) ?? "—"}
        </KV>
        <KV label="Dtype">{dtype ?? "—"}</KV>
        <KV label="Fill value">{fillValue ?? "—"}</KV>
      </dl>
      {rest.length > 0 && (
        <ul className="meta-list" style={{ marginTop: 6 }}>
          {rest.map((v) => (
            <li key={v.path}>
              <span className="mono">{v.path}</span>
              {v.role && (
                <span className="meta-muted" style={{ marginLeft: 6 }}>
                  · {v.role}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShardingSection({ codecs }: { codecs: CodecSummary | null }) {
  return (
    <div className="section">
      <span className="section-title">Storage</span>
      <dl className="meta-kv" style={{ marginTop: 6 }}>
        <KV
          label="Sharded"
          info="Zarr v3 sharding packs many small inner sub-chunks into one outer chunk file. The outer chunk (see Variable › Chunks above) is the unit on disk; the sub-chunk is the smallest unit a client fetches via HTTP byte-range. Lets producers choose large chunk files (low filesystem overhead) without forcing consumers to download the whole file for a small spatial slice."
        >
          {codecs == null
            ? "—"
            : codecs.sharded
              ? codecs.subChunkShape
                ? `yes · sub-chunk [${codecs.subChunkShape.join(", ")}]`
                : "yes"
              : "no"}
        </KV>
        <KV
          label="Compressor"
          info="The codec applied to each chunk's bytes. `blosc` is a meta-compressor wrapping an inner algorithm (zstd, lz4, …) with optional byte-shuffle preprocessing for better compression of typed-array data. `clevel` is the compression level (higher = smaller but slower to decode). `raw` means no compression."
        >
          {codecs?.compressor ?? "—"}
        </KV>
      </dl>
    </div>
  );
}

function GeoZarrSection({ structure }: { structure: StructureProfileSummary }) {
  const meta = structure.metadata;
  return (
    <div className="section">
      <span className="section-title">GeoZarr</span>
      <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
        <div style={{ display: "grid", gap: 4 }}>
          <SourceBadge source={structure.metadataSource} />
          <span
            className="meta-muted"
            style={{ fontSize: 11, lineHeight: 1.4 }}
          >
            {METADATA_SOURCE_DESC[structure.metadataSource]}
          </span>
        </div>
        {isRecord(meta) ? (
          <>
            <dl className="meta-kv">
              {GEOZARR_KEYS.map((k) =>
                k in meta ? (
                  <KV key={k} label={k}>
                    {formatJson(meta[k])}
                  </KV>
                ) : null,
              )}
            </dl>
            {(() => {
              const extras = Object.keys(meta).filter(
                (k) => !(GEOZARR_KEYS as readonly string[]).includes(k),
              );
              if (extras.length === 0) return null;
              return (
                <dl className="meta-kv">
                  {extras.map((k) => (
                    <KV key={k} label={k}>
                      {formatJson(meta[k])}
                    </KV>
                  ))}
                </dl>
              );
            })()}
          </>
        ) : (
          <span className="meta-muted">no GeoZarr attrs</span>
        )}
      </div>
    </div>
  );
}

function AttributesSection({ node }: { node: Props["node"] }) {
  const attrs = node && "attrs" in node ? node.attrs : null;
  if (!attrs || Object.keys(attrs).length === 0) {
    return (
      <div className="section">
        <span className="section-title">Attributes</span>
        <span className="meta-muted" style={{ marginTop: 6 }}>
          (none)
        </span>
      </div>
    );
  }
  return (
    <div className="section">
      <span className="section-title">Attributes</span>
      <dl className="meta-kv" style={{ marginTop: 6 }}>
        {Object.entries(attrs).map(([k, v]) => (
          <KV key={k} label={k}>
            {formatJson(v)}
          </KV>
        ))}
      </dl>
    </div>
  );
}

function KV({
  label,
  info,
  children,
}: {
  label: string;
  /** Optional help text — rendered as a `?` icon after the label that
   * shows the text in a hover tooltip. */
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="meta-kv-row">
      <dt
        style={
          info
            ? { display: "inline-flex", alignItems: "center", gap: 4 }
            : undefined
        }
      >
        {label}
        {info && <InfoIcon text={info} />}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function SourceBadge({ source }: { source: GeoZarrMetadataSource }) {
  const bg: Record<GeoZarrMetadataSource, string> = {
    "store-native": "#1f6b3a",
    injected: "#806010",
    synthesized: "#404488",
  };
  return (
    <span
      style={{
        display: "inline-block",
        // Inline-block items still stretch in a grid/flex parent unless
        // we explicitly anchor them. `justifySelf: "start"` keeps the
        // background pill sized to its text in the GeoZarr section's
        // stacked layout; it's ignored in non-grid contexts.
        justifySelf: "start",
        padding: "1px 6px",
        borderRadius: 3,
        background: bg[source],
        color: "#fff",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        fontWeight: 600,
      }}
    >
      {source}
    </span>
  );
}

function formatFillValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  return String(v);
}

/** Byte width of a zarrita dtype string (e.g. "float16" → 2). The trailing
 * number is the bit width for the float/int/uint families; `bool` is 1. */
function dtypeBytes(dtype: string): number | null {
  if (dtype === "bool") return 1;
  const m = /^(?:float|int|uint)(\d+)$/.exec(dtype);
  if (!m) return null;
  return Number(m[1]) / 8;
}

/** Estimated uncompressed bytes of one chunk = ∏(chunk dims) × dtype width.
 * Returns null when the dtype byte width is unknown. */
function formatChunkBytes(
  chunks: readonly number[] | null,
  dtype: string | null,
): string | null {
  if (!chunks || !dtype) return null;
  const bytes = dtypeBytes(dtype);
  if (bytes === null) return null;
  const elems = chunks.reduce((a, b) => a * b, 1);
  return formatBytes(elems * bytes);
}

/** Human-readable byte size: KB / MB / GB, ~3 significant figures. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function formatJson(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") {
    return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return v.toString();
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 197)}…` : s;
  } catch {
    return String(v);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

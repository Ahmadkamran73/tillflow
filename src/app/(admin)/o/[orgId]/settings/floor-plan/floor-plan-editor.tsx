"use client";

import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import {
  canPlace,
  firstFreeSpot,
  GRID,
  SHAPES,
  type Plan,
  type PlanFloor,
  type PlanTable,
} from "@/lib/restaurant/floor-plan";
import { saveFloorPlanAction } from "@/lib/restaurant/admin-actions";

const CELL = 40; // px per grid cell on screen

/**
 * Floor plan editor: tables on a grid. A table moves by dragging it (pointer) or with the arrow
 * keys when it is focused, so nothing needs a drag. Changes are kept here until Save.
 */
export function FloorPlanEditor({ orgId, initial }: { orgId: string; initial: Plan }) {
  const [plan, setPlan] = useState<Plan>(
    initial.length ? initial : [{ id: uuidv7(), name: t("floorplan.defaultFloor"), sort: 0, tables: [] }],
  );
  const [floorId, setFloorId] = useState(plan[0]!.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState({ text: "", ok: true, n: 0 });
  const [busy, setBusy] = useState(false);
  // A removal asks twice (select the same button again): the id being confirmed, or null.
  const [confirm, setConfirm] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const addTableButton = useRef<HTMLButtonElement>(null);
  // After adding a table its button takes focus, once it is on the page.
  const focusId = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId.current) return;
    document.querySelector<HTMLElement>(`[data-table-id="${focusId.current}"]`)?.focus();
    focusId.current = null;
  }, [plan]);
  const drag = useRef<{ id: string; dx: number; dy: number; startX: number; startY: number } | null>(
    null,
  );

  const floor = plan.find((f) => f.id === floorId) ?? plan[0]!;
  const table = floor.tables.find((x) => x.id === selected) ?? null;
  const say = (text: string, ok = true) => setStatus((s) => ({ text, ok, n: s.n + 1 }));

  const patchFloor = (id: string, f: (fl: PlanFloor) => PlanFloor) =>
    setPlan((p) => p.map((fl) => (fl.id === id ? f(fl) : fl)));
  const patchTable = (id: string, patch: Partial<PlanTable>) =>
    patchFloor(floor.id, (fl) => ({
      ...fl,
      tables: fl.tables.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));

  function moveTo(x: PlanTable, nx: number, ny: number, announce = true) {
    const box = { x: nx, y: ny, w: x.w, h: x.h };
    if (!canPlace(floor, x.id, box)) {
      if (announce) say(t("floorplan.blocked", { name: x.name }), false);
      return;
    }
    if (nx === x.x && ny === x.y) return;
    patchTable(x.id, { x: nx, y: ny });
    if (announce) say(t("floorplan.moved", { name: x.name, x: nx + 1, y: ny + 1 }));
  }

  function resize(x: PlanTable, w: number, h: number) {
    if (w < 1 || h < 1 || w > 8 || h > 8) return;
    if (!canPlace(floor, x.id, { x: x.x, y: x.y, w, h }))
      return say(t("floorplan.blocked", { name: x.name }), false);
    patchTable(x.id, { w, h });
    say(t("floorplan.resized", { name: x.name, w, h }));
  }

  function addTable() {
    const spot = firstFreeSpot(floor);
    if (!spot) return say(t("floorplan.blocked", { name: "" }), false);
    const names = new Set(floor.tables.map((x) => x.name.toLowerCase()));
    let n = floor.tables.length + 1;
    while (names.has(`t${n}`)) n++;
    const created: PlanTable = {
      id: uuidv7(),
      name: `T${n}`,
      seats: 4,
      shape: "square",
      ...spot,
      w: 2,
      h: 2,
    };
    patchFloor(floor.id, (fl) => ({ ...fl, tables: [...fl.tables, created] }));
    setSelected(created.id);
    focusId.current = created.id;
    say(t("floorplan.selected", { name: created.name, x: spot.x + 1, y: spot.y + 1 }));
  }

  function removeTable(x: PlanTable) {
    if (confirm !== x.id) {
      setConfirm(x.id);
      return say(t("floorplan.confirmRemove", { name: x.name }));
    }
    patchFloor(floor.id, (fl) => ({ ...fl, tables: fl.tables.filter((y) => y.id !== x.id) }));
    setSelected(null);
    setConfirm(null);
    say(t("floorplan.removed", { name: x.name }));
    addTableButton.current?.focus(); // the removed table had focus
  }

  function addFloor() {
    const created: PlanFloor = {
      id: uuidv7(),
      name: t("floorplan.newFloor", { n: plan.length + 1 }),
      sort: plan.length,
      tables: [],
    };
    setPlan((p) => [...p, created]);
    setFloorId(created.id);
    setSelected(null);
  }

  function removeFloor() {
    if (plan.length < 2) return say(t("floorplan.lastFloor"), false);
    if (confirm !== floor.id) {
      setConfirm(floor.id);
      return say(t("floorplan.confirmRemove", { name: floor.name }));
    }
    const rest = plan.filter((f) => f.id !== floor.id);
    setPlan(rest);
    setFloorId(rest[0]!.id);
    setSelected(null);
    setConfirm(null);
    say(t("floorplan.floorRemoved", { name: floor.name }));
    addTableButton.current?.focus();
  }

  // Pointer drag: the table follows the pointer snapped to the grid; invalid cells are ignored.
  function pointerCell(e: React.PointerEvent) {
    const r = canvas.current?.getBoundingClientRect();
    if (!r) return null;
    return {
      cx: Math.floor((e.clientX - r.left) / CELL),
      cy: Math.floor((e.clientY - r.top) / CELL),
    };
  }

  async function save() {
    setBusy(true);
    const r = await saveFloorPlanAction(
      orgId,
      plan.map((f, i) => ({ ...f, sort: i })),
    );
    setBusy(false);
    if (r.ok) say(t("floorplan.saved"));
    else
      say(
        r.error === "overlap"
          ? t("floorplan.overlap", { floor: floor.name })
          : t("floorplan.errorTable", { floor: floor.name }),
        false,
      );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label={t("floorplan.floors")}
        className="flex flex-wrap items-center gap-2"
      >
        {plan.map((f) => (
          <Button
            key={f.id}
            size="touch"
            variant={f.id === floor.id ? "default" : "outline"}
            aria-pressed={f.id === floor.id}
            onClick={() => {
              setFloorId(f.id);
              setSelected(null);
              setConfirm(null);
            }}
          >
            {f.name}
          </Button>
        ))}
        <Button size="touch" variant="outline" onClick={addFloor}>
          {t("floorplan.addFloor")}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("floorplan.floor")}
          <Input
            className="h-12 w-56"
            maxLength={40}
            value={floor.name}
            onChange={(e) => patchFloor(floor.id, (fl) => ({ ...fl, name: e.target.value }))}
          />
        </label>
        <Button
          size="touch"
          variant="outline"
          onClick={removeFloor}
          aria-disabled={plan.length < 2}
        >
          {t("floorplan.removeFloor")}
        </Button>
        <Button ref={addTableButton} size="touch" variant="outline" onClick={addTable}>
          {t("floorplan.addTable")}
        </Button>
      </div>

      <div className="overflow-auto rounded-lg border">
        <div
          ref={canvas}
          role="group"
          aria-label={t("floorplan.canvas")}
          className="bg-paper relative"
          style={{
            width: GRID.cols * CELL,
            height: GRID.rows * CELL,
            backgroundImage:
              "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: `${CELL}px ${CELL}px`,
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            const c = pointerCell(e);
            const x = d && floor.tables.find((tb) => tb.id === d.id);
            if (d && c && x) moveTo(x, c.cx - d.dx, c.cy - d.dy, false);
          }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = null;
            const x = d && floor.tables.find((tb) => tb.id === d.id);
            if (x && (x.x !== d.startX || x.y !== d.startY)) say(t("floorplan.moved", { name: x.name, x: x.x + 1, y: x.y + 1 }));
          }}
        >
          {floor.tables.map((x) => (
            <button
              key={x.id}
              type="button"
              data-table-id={x.id}
              aria-pressed={selected === x.id}
              aria-label={`${t("tables.table", { name: x.name })}, ${t("tables.seats", { count: x.seats })}`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const c = pointerCell(e);
                setSelected(x.id);
                if (c) drag.current = { id: x.id, dx: c.cx - x.x, dy: c.cy - x.y, startX: x.x, startY: x.y };
              }}
              onPointerCancel={() => (drag.current = null)}
              onFocus={() => setSelected(x.id)}
              onKeyDown={(e) => {
                const step: Record<string, [number, number]> = {
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                };
                const s = step[e.key];
                if (!s) return;
                e.preventDefault();
                moveTo(x, x.x + s[0], x.y + s[1]);
              }}
              className={`absolute touch-none flex flex-col items-center justify-center border-2 text-center text-sm font-semibold ${
                x.shape === "round" ? "rounded-full" : "rounded-lg"
              } ${selected === x.id ? "border-primary bg-accent border-4" : "border-solid-border bg-background"}`}
              style={{
                left: x.x * CELL + 2,
                top: x.y * CELL + 2,
                width: x.w * CELL - 4,
                height: x.h * CELL - 4,
              }}
            >
              <span>{x.name}</span>
              <span className="text-muted-foreground text-xs">
                {t("tables.seats", { count: x.seats })}
              </span>
            </button>
          ))}
        </div>
      </div>
      {floor.tables.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("floorplan.noTables")}</p>
      )}

      {table && (
        <fieldset className="surface-panel flex flex-wrap items-end gap-3 p-4">
          <legend className="px-1 font-semibold">{t("tables.table", { name: table.name })}</legend>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("floorplan.tableName")}
            <Input
              className="h-12 w-32"
              maxLength={20}
              value={table.name}
              onChange={(e) => patchTable(table.id, { name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("floorplan.seats")}
            <Input
              className="h-12 w-24"
              type="number"
              min={1}
              max={30}
              value={table.seats}
              onChange={(e) =>
                patchTable(table.id, {
                  seats: Math.min(30, Math.max(1, Number(e.target.value) || 1)),
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("floorplan.shape")}
            <select
              className="border-input bg-background h-12 rounded-md border px-3"
              value={table.shape}
              onChange={(e) =>
                patchTable(table.id, { shape: e.target.value as PlanTable["shape"] })
              }
            >
              {SHAPES.map((s) => (
                <option key={s} value={s}>
                  {t(`floorplan.shape.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <div role="group" aria-label={t("floorplan.size")} className="flex gap-2">
            <Button
              size="touch"
              variant="outline"
              onClick={() => resize(table, table.w + 1, table.h)}
            >
              {t("floorplan.wider")}
            </Button>
            <Button
              size="touch"
              variant="outline"
              onClick={() => resize(table, table.w - 1, table.h)}
            >
              {t("floorplan.narrower")}
            </Button>
            <Button
              size="touch"
              variant="outline"
              onClick={() => resize(table, table.w, table.h + 1)}
            >
              {t("floorplan.taller")}
            </Button>
            <Button
              size="touch"
              variant="outline"
              onClick={() => resize(table, table.w, table.h - 1)}
            >
              {t("floorplan.shorter")}
            </Button>
          </div>
          <div role="group" aria-label={t("floorplan.move")} className="flex gap-2">
            <Button size="touch" variant="outline" onClick={() => moveTo(table, table.x - 1, table.y)}>
              {t("floorplan.left")}
            </Button>
            <Button size="touch" variant="outline" onClick={() => moveTo(table, table.x + 1, table.y)}>
              {t("floorplan.right")}
            </Button>
            <Button size="touch" variant="outline" onClick={() => moveTo(table, table.x, table.y - 1)}>
              {t("floorplan.up")}
            </Button>
            <Button size="touch" variant="outline" onClick={() => moveTo(table, table.x, table.y + 1)}>
              {t("floorplan.down")}
            </Button>
          </div>
          <Button size="touch" variant="outline" onClick={() => removeTable(table)}>
            {t("floorplan.removeTable")}
          </Button>
        </fieldset>
      )}

      <p
        role="status"
        className={status.text ? (status.ok ? "text-sm" : "text-destructive text-sm") : "sr-only"}
      >
        {status.text}
      </p>
      <div>
        <Button size="touch" aria-disabled={busy} onClick={() => !busy && void save()}>
          {busy ? t("floorplan.saving") : t("floorplan.save")}
        </Button>
      </div>
    </div>
  );
}

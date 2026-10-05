import "./setup";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StationMap } from "../src/components/StationMap";
import { stations } from "../src/data";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["success", "denied"])(
  "геолокация: %s показывает результат и не использует выдуманное время в пути",
  async (outcome) => {
    vi.stubEnv("VITE_YANDEX_MAPS_API_KEY", "test");
    const move = vi.fn();
    class Entity {
      parent: unknown;
      addChild(entity: Entity) {
        entity.parent = this;
        return this;
      }
      removeChild(entity: Entity) {
        entity.parent = null;
      }
    }
    class Map extends Entity {
      zoom = 13;
      setLocation = move;
      destroy() {}
    }
    vi.stubGlobal("ymaps3", {
      ready: Promise.resolve(),
      YMap: Map,
      YMapDefaultSchemeLayer: Entity,
      YMapDefaultFeaturesLayer: Entity,
      YMapCollection: Entity,
      YMapMarker: Entity,
      import: () => Promise.reject(new Error("Markers")),
    });
    const original = Object.getOwnPropertyDescriptor(navigator, "geolocation");
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (position: {
            coords: { longitude: number; latitude: number };
          }) => void,
          failure: () => void,
        ) =>
          outcome === "success"
            ? success({ coords: { longitude: 37.6, latitude: 55.7 } })
            : failure(),
      },
    });
    try {
      render(
        <MemoryRouter>
          <StationMap stations={stations} selectedId={stations[0].id} />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Моё местоположение",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Моё местоположение" }),
      );
      if (outcome === "success") {
        expect(move).toHaveBeenLastCalledWith({
          center: [37.6, 55.7],
          zoom: 13,
          duration: 400,
        });
        expect(
          screen.getByText("Карта перемещена к вашему местоположению."),
        ).toBeTruthy();
      } else expect(screen.getByText(/Местоположение недоступно/)).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Закрыть сообщение карты" }),
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText(/мин/)).toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, "geolocation", original);
      else Reflect.deleteProperty(navigator, "geolocation");
    }
  },
);
it("обновление объектов станций сохраняет масштаб; смена выбранной станции меняет камеру", async () => {
  vi.stubEnv("VITE_YANDEX_MAPS_API_KEY", "test");
  const move = vi.fn();
  class Entity {
    parent: unknown;
    addChild(entity: Entity) {
      entity.parent = this;
      return this;
    }
    removeChild(entity: Entity) {
      entity.parent = null;
    }
  }
  class Map extends Entity {
    zoom = 13;
    setLocation = move;
    destroy() {}
  }
  vi.stubGlobal("ymaps3", {
    ready: Promise.resolve(),
    YMap: Map,
    YMapDefaultSchemeLayer: Entity,
    YMapDefaultFeaturesLayer: Entity,
    YMapCollection: Entity,
    YMapMarker: Entity,
    import: () => Promise.reject(new Error("Fallback to markers")),
  });
  const view = render(
    <MemoryRouter>
      <StationMap stations={stations} selectedId={stations[0].id} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Приблизить карту" }));
  expect(move).toHaveBeenLastCalledWith({ zoom: 14, duration: 200 });
  const count = move.mock.calls.length;
  view.rerender(
    <MemoryRouter>
      <StationMap
        stations={structuredClone(stations)}
        selectedId={stations[0].id}
      />
    </MemoryRouter>,
  );
  expect(move).toHaveBeenCalledTimes(count);
  view.rerender(
    <MemoryRouter>
      <StationMap
        stations={structuredClone(stations)}
        selectedId={stations[1].id}
      />
    </MemoryRouter>,
  );
  expect(move).toHaveBeenLastCalledWith({
    center: stations[1].coordinates,
    zoom: 13,
    duration: 400,
  });
});

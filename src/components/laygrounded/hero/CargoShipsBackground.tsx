"use client";

import React, { useEffect, useState } from "react";
import styles from "./CargoShipsBackground.module.css";

interface ShipProps {
  id: number;
  top: number;
  opacity: number;
  scale: number;
  driftDuration: number;
  driftDelay: number;
  bobDuration: number;
  bobDelay: number;
}

export function CargoShipsBackground() {
  const [ships, setShips] = useState<ShipProps[]>([]);

  useEffect(() => {
    const newShips: ShipProps[] = [];
    const numShips = 12 + Math.floor(Math.random() * 4); // 12-15 ships

    for (let i = 0; i < numShips; i++) {
      newShips.push({
        id: i,
        top: 10 + Math.random() * 80, // 10% to 90%
        opacity: 0.4 + Math.random() * 0.4, // 0.4 to 0.8
        scale: 0.5 + Math.random(), // 0.5 to 1.5
        driftDuration: 40 + Math.random() * 80, // 40s to 120s
        driftDelay: -(Math.random() * 80 + 20), // -20s to -100s
        bobDuration: 3 + Math.random() * 3, // 3s to 6s
        bobDelay: Math.random() * -6, // randomize bob starting point
      });
    }

    setShips(newShips);
  }, []);

  return (
    <div className={styles.container}>
      {ships.map((ship) => (
        <div
          key={ship.id}
          className={styles.driftingWrapper}
          style={{
            top: `${ship.top}%`,
            animationDuration: `${ship.driftDuration}s`,
            animationDelay: `${ship.driftDelay}s`,
          }}
        >
          <div
            style={{
              transform: `scale(${ship.scale})`,
              opacity: ship.opacity,
            }}
          >
            <div
              className={styles.bobbingShip}
              style={{
                animationDuration: `${ship.bobDuration}s`,
                animationDelay: `${ship.bobDelay}s`,
                color: "#0f172a",
              }}
            >
              <svg
                className={styles.shipSvg}
                viewBox="0 0 100 40"
                fill="currentColor"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Hull */}
                <path d="M5,35 L90,35 L98,20 L0,20 Z" />

                {/* Bridge */}
                <rect x="75" y="5" width="15" height="15" />
                <rect x="80" y="2" width="5" height="3" />

                {/* Containers (First Row) */}
                <rect x="15" y="10" width="10" height="10" />
                <rect x="27" y="10" width="10" height="10" />
                <rect x="39" y="10" width="10" height="10" />
                <rect x="51" y="10" width="10" height="10" />
                <rect x="63" y="10" width="10" height="10" />

                {/* Containers (Second Row - partial) */}
                <rect x="15" y="0" width="10" height="10" />
                <rect x="27" y="0" width="10" height="10" />
                <rect x="39" y="0" width="10" height="10" />
              </svg>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

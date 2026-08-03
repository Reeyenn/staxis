'use client';

import { Check, ChevronDown, MapPinned } from 'lucide-react';
import React from 'react';

import styles from './HotelSwitcher.module.css';

export interface HotelSwitcherOption {
  id: string;
  name: string;
}

interface HotelSwitcherProps {
  hotels: readonly HotelSwitcherOption[];
  activeHotelId: string | null;
  label: string;
  placeholder: string;
  onSelect: (hotelId: string) => void;
  className?: string;
}

function normalizedSearchValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

export function HotelSwitcher({
  hotels,
  activeHotelId,
  label,
  placeholder,
  onSelect,
  className,
}: HotelSwitcherProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const typeaheadTimerRef = React.useRef<number | null>(null);
  const typeaheadValueRef = React.useRef('');
  const listboxId = React.useId();
  const [open, setOpen] = React.useState(false);
  const activeIndex = hotels.findIndex((hotel) => hotel.id === activeHotelId);
  const [highlightedIndex, setHighlightedIndex] = React.useState(activeIndex >= 0 ? activeIndex : 0);
  const activeHotel = activeIndex >= 0 ? hotels[activeIndex] : null;

  const closeMenu = React.useCallback(() => {
    setOpen(false);
    typeaheadValueRef.current = '';
  }, []);

  const openMenu = React.useCallback((preferredIndex?: number) => {
    const nextIndex = preferredIndex ?? (activeIndex >= 0 ? activeIndex : 0);
    setHighlightedIndex(Math.max(0, Math.min(nextIndex, hotels.length - 1)));
    setOpen(true);
  }, [activeIndex, hotels.length]);

  const chooseHotel = React.useCallback((index: number) => {
    const hotel = hotels[index];
    if (!hotel) return;
    closeMenu();
    setHighlightedIndex(index);
    if (hotel.id !== activeHotelId) onSelect(hotel.id);
  }, [activeHotelId, closeMenu, hotels, onSelect]);

  React.useEffect(() => {
    if (activeIndex >= 0) setHighlightedIndex(activeIndex);
    closeMenu();
  }, [activeIndex, closeMenu]);

  React.useEffect(() => {
    if (!open) return undefined;

    const closeWhenOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeMenu();
    };

    document.addEventListener('pointerdown', closeWhenOutside, true);
    document.addEventListener('focusin', closeWhenOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside, true);
      document.removeEventListener('focusin', closeWhenOutside, true);
    };
  }, [closeMenu, open]);

  React.useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  React.useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  const moveHighlight = (direction: 1 | -1) => {
    if (hotels.length === 0) return;
    setHighlightedIndex((current) => Math.max(0, Math.min(current + direction, hotels.length - 1)));
  };

  const runTypeahead = (key: string) => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    const normalizedKey = normalizedSearchValue(key);
    const previousQuery = typeaheadValueRef.current;
    const cyclingOneLetter = previousQuery.length > 0
      && [...previousQuery].every((character) => character === normalizedKey);
    typeaheadValueRef.current = cyclingOneLetter ? normalizedKey : `${previousQuery}${normalizedKey}`;
    const query = typeaheadValueRef.current;
    const startIndex = Math.max(highlightedIndex, -1);
    const orderedHotels = [...hotels.slice(startIndex + 1), ...hotels.slice(0, startIndex + 1)];
    const match = orderedHotels.find((hotel) => normalizedSearchValue(hotel.name).startsWith(query));
    if (match) setHighlightedIndex(hotels.findIndex((hotel) => hotel.id === match.id));
    else typeaheadValueRef.current = '';
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadValueRef.current = '';
      typeaheadTimerRef.current = null;
    }, 650);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu(event.key === 'ArrowDown' ? (activeIndex >= 0 ? activeIndex : 0) : hotels.length - 1);
      else moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      if (open) setHighlightedIndex(0);
      else openMenu(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      if (open) setHighlightedIndex(hotels.length - 1);
      else openMenu(hotels.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) chooseHotel(highlightedIndex);
      else openMenu();
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }

    if (event.key === 'Tab') {
      if (open) chooseHotel(highlightedIndex);
      else closeMenu();
      return;
    }

    if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1 && event.key.trim()) {
      if (!open) openMenu();
      runTypeahead(event.key);
    }
  };

  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  return (
    <div ref={rootRef} className={rootClassName}>
      <button
        type="button"
        className={styles.trigger}
        role="combobox"
        aria-label={`${label}: ${activeHotel?.name ?? placeholder}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && hotels[highlightedIndex] ? `${listboxId}-option-${highlightedIndex}` : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
        disabled={hotels.length === 0}
      >
        <MapPinned className={styles.triggerIcon} size={17} aria-hidden="true" />
        <span className={styles.triggerValue}>{activeHotel?.name ?? placeholder}</span>
        <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
      </button>

      {open ? (
        <div id={listboxId} className={styles.menu} role="listbox" aria-label={label}>
          {hotels.map((hotel, index) => {
            const selected = hotel.id === activeHotelId;
            const highlighted = index === highlightedIndex;
            return (
              <button
                key={hotel.id}
                ref={(node) => { optionRefs.current[index] = node; }}
                id={`${listboxId}-option-${index}`}
                type="button"
                className={styles.option}
                role="option"
                aria-selected={selected}
                data-highlighted={highlighted ? 'true' : undefined}
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setHighlightedIndex(index)}
                onClick={() => chooseHotel(index)}
              >
                <span className={styles.checkSlot} aria-hidden="true">
                  {selected ? <Check size={16} strokeWidth={2.4} /> : null}
                </span>
                <span className={styles.optionLabel}>{hotel.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

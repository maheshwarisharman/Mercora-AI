import React, { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, X } from "lucide-react";

interface ModernDatePickerProps {
  label?: string;
  value: string; // Format: "YYYY-MM-DD"
  onChange: (value: string) => void;
  placeholder?: string;
  minDate?: string;
  maxDate?: string;
  required?: boolean;
  align?: "left" | "right";
  className?: string;
  id?: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const DAYS_OF_WEEK = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export const ModernDatePicker: React.FC<ModernDatePickerProps> = ({
  label,
  value,
  onChange,
  placeholder = "Select date",
  minDate,
  maxDate,
  required = false,
  align = "left",
  className = "",
  id,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse initial view date
  const parseDate = (dateStr: string): Date | null => {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  };

  const selectedDate = parseDate(value);

  // Navigation state (month & year)
  const initialDate = selectedDate || new Date();
  const [viewYear, setViewYear] = useState<number>(initialDate.getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(initialDate.getMonth()); // 0 - 11

  // Update view when value changes
  useEffect(() => {
    if (selectedDate) {
      setViewYear(selectedDate.getFullYear());
      setViewMonth(selectedDate.getMonth());
    }
  }, [value]);

  // Handle click outside to close popover
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handlePrevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((prev) => prev - 1);
    } else {
      setViewMonth((prev) => prev - 1);
    }
  };

  const handleNextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((prev) => prev + 1);
    } else {
      setViewMonth((prev) => prev + 1);
    }
  };

  const handleSelectDay = (day: number) => {
    const mm = String(viewMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const formatted = `${viewYear}-${mm}-${dd}`;
    onChange(formatted);
    setIsOpen(false);
  };

  // Format date display for input trigger
  const formatDisplay = (dateStr: string) => {
    const d = parseDate(dateStr);
    if (!d) return "";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  // Generate calendar grid
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const isToday = (day: number) => {
    const today = new Date();
    return (
      today.getFullYear() === viewYear &&
      today.getMonth() === viewMonth &&
      today.getDate() === day
    );
  };

  const isSelected = (day: number) => {
    if (!selectedDate) return false;
    return (
      selectedDate.getFullYear() === viewYear &&
      selectedDate.getMonth() === viewMonth &&
      selectedDate.getDate() === day
    );
  };

  const isDateDisabled = (day: number) => {
    const currentStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (minDate && currentStr < minDate) return true;
    if (maxDate && currentStr > maxDate) return true;
    return false;
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {label && (
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-[#18324b] mb-1.5"
        >
          {label}
          {required && <span className="text-rose-500 ml-0.5">*</span>}
        </label>
      )}

      {/* Input Trigger Button */}
      <div
        id={id}
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between px-3 py-2 text-sm bg-white border ${
          isOpen
            ? "border-[#18324b] ring-2 ring-[#18324b]/10 shadow-sm"
            : "border-[#dfe7e3] hover:border-[#b8c9c3]"
        } rounded-lg cursor-pointer transition-all select-none`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <CalendarIcon size={15} className="text-[#567079] shrink-0" />
          <span
            className={`truncate font-medium text-xs sm:text-sm ${
              value ? "text-[#18324b]" : "text-[#8fa3a6]"
            }`}
          >
            {value ? formatDisplay(value) : placeholder}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {value && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              className="p-0.5 text-[#8fa3a6] hover:text-[#18324b] hover:bg-[#f0f4f2] rounded transition-colors"
              title="Clear date"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Calendar Popover */}
      {isOpen && (
        <div
          className={`absolute z-50 mt-2 ${
            align === "right" ? "right-0" : "left-0"
          } w-72 bg-white rounded-2xl p-4 border border-slate-100 shadow-[0_16px_36px_-6px_rgba(15,23,42,0.16)] transition-all`}
        >
          {/* Header: Month & Year + Navigation Chevrons */}
          <div className="flex items-center justify-between mb-4 px-1">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-1 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 active:scale-95 transition-all"
              aria-label="Previous month"
            >
              <ChevronLeft size={16} strokeWidth={2.5} />
            </button>

            <div className="text-[15px] font-bold text-[#18324b] tracking-tight">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>

            <button
              type="button"
              onClick={handleNextMonth}
              className="p-1 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 active:scale-95 transition-all"
              aria-label="Next month"
            >
              <ChevronRight size={16} strokeWidth={2.5} />
            </button>
          </div>

          {/* Days of Week Header */}
          <div className="grid grid-cols-7 gap-1 mb-2 text-center">
            {DAYS_OF_WEEK.map((day) => (
              <div
                key={day}
                className="text-[12px] font-medium text-slate-400 py-0.5"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-1 text-center">
            {/* Blank padding days */}
            {Array.from({ length: firstDayOfMonth }).map((_, idx) => (
              <div key={`blank-${idx}`} className="h-8 w-8" />
            ))}

            {/* Month days */}
            {Array.from({ length: daysInMonth }).map((_, idx) => {
              const day = idx + 1;
              const selected = isSelected(day);
              const disabled = isDateDisabled(day);
              const today = isToday(day);

              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleSelectDay(day)}
                  className={`h-8 w-8 mx-auto flex items-center justify-center text-xs transition-all ${
                    selected
                      ? "bg-[#18324b] text-white font-bold rounded-xl shadow-sm scale-105"
                      : disabled
                      ? "text-slate-300 cursor-not-allowed"
                      : today
                      ? "text-[#18324b] font-bold bg-[#edf3f1] hover:bg-[#dfe9e6] rounded-xl"
                      : "text-slate-700 font-medium hover:bg-slate-100 hover:text-slate-900 rounded-xl"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Quick Actions Footer */}
          <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs px-1">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                const mm = String(now.getMonth() + 1).padStart(2, "0");
                const dd = String(now.getDate()).padStart(2, "0");
                onChange(`${now.getFullYear()}-${mm}-${dd}`);
                setIsOpen(false);
              }}
              className="text-[#18324b] font-semibold hover:underline"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-slate-400 hover:text-slate-600 font-medium"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

const DATE_OPTIONS = [
  { label: "Tonight", value: "tonight" },
  { label: "This weekend", value: "weekend" },
  { label: "Next 7 days", value: "week" },
  { label: "This month", value: "month" },
];

const PRICE_OPTIONS = [
  { label: "Under $25", value: "0-25" },
  { label: "$25 – $50", value: "25-50" },
  { label: "$50 – $100", value: "50-100" },
  { label: "$100+", value: "100+" },
];

const CATEGORY_OPTIONS = [
  { label: "Concerts", value: "concerts" },
  { label: "Sports", value: "sports" },
  { label: "Comedy", value: "comedy" },
  { label: "Theatre", value: "theatre" },
  { label: "Festivals", value: "festivals" },
];

const AVAILABILITY_OPTIONS = [
  { label: "On sale", value: "on-sale" },
  { label: "Hide sold out", value: "hide-sold-out" },
  { label: "Resale only", value: "resale-only" },
];

export default function BrowseFiltersClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dateSelected, setDateSelected] = useState(searchParams.get("date") || "");
  const [priceSelected, setPriceSelected] = useState<string[]>(
    searchParams.get("price")?.split(",") || []
  );
  const [categorySelected, setCategorySelected] = useState<string[]>(
    searchParams.get("category")?.split(",") || []
  );
  const [availabilitySelected, setAvailabilitySelected] = useState(
    searchParams.get("availability") || ""
  );

  const handleDateChange = (value: string) => {
    setDateSelected(value);
    const params = new URLSearchParams();
    if (value) params.set("date", value);
    if (priceSelected.length > 0) params.set("price", priceSelected.join(","));
    if (categorySelected.length > 0) params.set("category", categorySelected.join(","));
    if (availabilitySelected) params.set("availability", availabilitySelected);
    router.push(`${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const handlePriceChange = (value: string) => {
    const updated = priceSelected.includes(value)
      ? priceSelected.filter((p) => p !== value)
      : [...priceSelected, value];
    setPriceSelected(updated);
    const params = new URLSearchParams();
    if (dateSelected) params.set("date", dateSelected);
    if (updated.length > 0) params.set("price", updated.join(","));
    if (categorySelected.length > 0) params.set("category", categorySelected.join(","));
    if (availabilitySelected) params.set("availability", availabilitySelected);
    router.push(`${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const handleCategoryChange = (value: string) => {
    const updated = categorySelected.includes(value)
      ? categorySelected.filter((c) => c !== value)
      : [...categorySelected, value];
    setCategorySelected(updated);
    const params = new URLSearchParams();
    if (dateSelected) params.set("date", dateSelected);
    if (priceSelected.length > 0) params.set("price", priceSelected.join(","));
    if (updated.length > 0) params.set("category", updated.join(","));
    if (availabilitySelected) params.set("availability", availabilitySelected);
    router.push(`${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const handleAvailabilityChange = (value: string) => {
    setAvailabilitySelected(value);
    const params = new URLSearchParams();
    if (dateSelected) params.set("date", dateSelected);
    if (priceSelected.length > 0) params.set("price", priceSelected.join(","));
    if (categorySelected.length > 0) params.set("category", categorySelected.join(","));
    if (value) params.set("availability", value);
    router.push(`${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const handleReset = () => {
    setDateSelected("");
    setPriceSelected([]);
    setCategorySelected([]);
    setAvailabilitySelected("");
    router.push(window.location.pathname);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Filters header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Filters</h3>
        {(dateSelected || priceSelected.length > 0 || categorySelected.length > 0 || availabilitySelected) && (
          <button
            onClick={handleReset}
            className="text-xs text-accent font-medium hover:text-accent/80 transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* Date filter */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase text-mute tracking-wider">Date</label>
          <span className="text-[10px] font-mono text-fade">1 of {DATE_OPTIONS.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {DATE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleDateChange(opt.value === dateSelected ? "" : opt.value)}
              className={cn(
                "text-left text-xs px-2 py-1.5 rounded-sm transition-colors",
                dateSelected === opt.value
                  ? "bg-subtle border border-line"
                  : "border border-transparent hover:bg-subtle"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Price filter */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase text-mute tracking-wider">Price</label>
          <span className="text-[10px] font-mono text-fade">any</span>
        </div>
        <div className="flex flex-col gap-2">
          {PRICE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handlePriceChange(opt.value)}
              className={cn(
                "text-left text-xs px-2 py-1.5 rounded-sm transition-colors",
                priceSelected.includes(opt.value)
                  ? "bg-subtle border border-line"
                  : "border border-transparent hover:bg-subtle"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Category filter */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase text-mute tracking-wider">Category</label>
          <span className="text-[10px] font-mono text-fade">any</span>
        </div>
        <div className="flex flex-col gap-2">
          {CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleCategoryChange(opt.value)}
              className={cn(
                "text-left text-xs px-2 py-1.5 rounded-sm transition-colors",
                categorySelected.includes(opt.value)
                  ? "bg-subtle border border-line"
                  : "border border-transparent hover:bg-subtle"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Availability filter */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase text-mute tracking-wider">Availability</label>
          <span className="text-[10px] font-mono text-fade">1 of {AVAILABILITY_OPTIONS.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {AVAILABILITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleAvailabilityChange(opt.value === availabilitySelected ? "" : opt.value)}
              className={cn(
                "text-left text-xs px-2 py-1.5 rounded-sm transition-colors",
                availabilitySelected === opt.value
                  ? "bg-subtle border border-line"
                  : "border border-transparent hover:bg-subtle"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

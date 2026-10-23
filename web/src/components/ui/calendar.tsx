import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// shadcn's Calendar (react-day-picker v9), on this app's tokens: the day buttons are Geist's
// tertiary (ghost) button, the chosen day the primary, today a tinted fill.
function Calendar({ className, classNames, showOutsideDays = true, ...props }: React.ComponentProps<typeof DayPicker>) {
  const d = getDefaultClassNames();
  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays={showOutsideDays}
      className={cn("p-1 [--cell-size:2rem]", className)}
      classNames={{
        root: cn("w-fit", d.root),
        months: cn("relative flex flex-col gap-4", d.months),
        month: cn("flex w-full flex-col gap-3", d.month),
        nav: cn("absolute inset-x-0 top-0 flex items-center justify-between", d.nav),
        button_previous: cn(buttonVariants({ variant: "ghost" }), "size-(--cell-size) p-0 aria-disabled:opacity-50", d.button_previous),
        button_next: cn(buttonVariants({ variant: "ghost" }), "size-(--cell-size) p-0 aria-disabled:opacity-50", d.button_next),
        month_caption: cn("flex h-(--cell-size) items-center justify-center", d.month_caption),
        caption_label: cn("text-sm font-medium select-none", d.caption_label),
        month_grid: cn("w-full border-collapse", d.month_grid),
        weekdays: cn("flex", d.weekdays),
        weekday: cn("text-muted-foreground w-(--cell-size) text-xs font-normal select-none", d.weekday),
        week: cn("mt-1 flex w-full", d.week),
        day: cn("relative size-(--cell-size) p-0 text-center select-none", d.day),
        day_button: cn(buttonVariants({ variant: "ghost" }), "size-(--cell-size) p-0 text-sm font-normal", d.day_button),
        selected: "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary/85",
        today: cn("[&:not([aria-selected=true])>button]:bg-accent [&>button]:font-medium", d.today),
        outside: cn("text-muted-foreground opacity-60", d.outside),
        disabled: cn("text-muted-foreground opacity-40 [&>button]:pointer-events-none", d.disabled),
        hidden: cn("invisible", d.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: c, ...rest }) =>
          orientation === "left" ? <ChevronLeftIcon className={cn("size-4", c)} {...rest} /> : <ChevronRightIcon className={cn("size-4", c)} {...rest} />,
      }}
      {...props}
    />
  );
}

export { Calendar };

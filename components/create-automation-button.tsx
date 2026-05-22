"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CreateAutomationButtonProps {
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  children: React.ReactNode;
  iconClassName?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export function CreateAutomationButton({
  size = "default",
  className,
  children,
  iconClassName = "w-4 h-4 mr-2",
  onClick,
  disabled,
}: CreateAutomationButtonProps) {
  return (
    <Button size={size} className={className} onClick={onClick} disabled={disabled}>
      <Plus className={iconClassName} />
      {children}
    </Button>
  );
}


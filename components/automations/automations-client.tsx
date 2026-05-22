"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AutomationCard, Automation } from "@/components/automation-card";
import { AutomationModal } from "@/components/automations/automation-modal";
import { CreateAutomationButton } from "@/components/create-automation-button";
import { Plus } from "lucide-react";
import { toast } from "sonner";

interface AutomationsClientProps {
  initialAutomations: Automation[];
}

export function AutomationsClient({ initialAutomations }: AutomationsClientProps) {
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | undefined>(undefined);
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);

  const handleCreateClick = () => {
    setSelectedAutomation(undefined);
    setIsModalOpen(true);
  };

  const handleEditClick = (automation: Automation) => {
    setSelectedAutomation(automation);
    setIsModalOpen(true);
  };

  const handleDeleteClick = async (automation: Automation) => {
    if (!window.confirm("Are you sure you want to delete this automation?")) {
      return;
    }

    setIsDeletingId(automation.id);
    try {
      const response = await fetch(`/api/admin/automations/${automation.id}`, {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Automation deleted successfully");
        router.refresh();
      } else {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error || "Failed to delete automation");
      }
    } catch (error) {
      toast.error("Failed to delete automation");
    } finally {
      setIsDeletingId(null);
    }
  };

  const handleSuccess = () => {
    router.refresh();
  };

  if (initialAutomations.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground">
              Automations
            </h1>
            <p className="text-muted-foreground mt-1 text-lg">
              Configure recurring tasks like briefings and weekly reports.
            </p>
          </div>
        </div>

        <div className="mt-8 p-12 rounded-xl border border-border bg-accent/5 flex flex-col items-center justify-center text-center min-h-[400px]">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-4">
            <Plus className="w-8 h-8 text-accent/50" />
          </div>
          <h3 className="text-xl font-semibold">No automations found</h3>
          <p className="text-muted-foreground max-w-sm mt-2">
            Create your first automated workflow to stay on top of your schedule and insights.
          </p>
          <CreateAutomationButton 
            className="mt-6" 
            onClick={handleCreateClick}
          >
            Create Automation
          </CreateAutomationButton>
        </div>

        <AutomationModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSuccess={handleSuccess}
          automation={selectedAutomation}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Automations
          </h1>
          <p className="text-muted-foreground mt-1 text-lg">
            Configure recurring tasks like briefings and weekly reports.
          </p>
        </div>
        <CreateAutomationButton 
          size="lg" 
          className="shadow-lg shadow-accent/20" 
          iconClassName="w-5 h-5 mr-2"
          onClick={handleCreateClick}
        >
          New Automation
        </CreateAutomationButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mt-8">
        {initialAutomations.map((automation) => (
          <AutomationCard 
            key={automation.id} 
            automation={automation} 
            onEdit={() => handleEditClick(automation)}
            onDelete={() => handleDeleteClick(automation)}
          />
        ))}
      </div>

      <AutomationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleSuccess}
        automation={selectedAutomation}
      />
    </div>
  );
}

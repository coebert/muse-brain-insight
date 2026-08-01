export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      depth_calibrations: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          metrics: Json
          name: string
          params: Json
          source_session_ids: string[]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          metrics?: Json
          name: string
          params: Json
          source_session_ids?: string[]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          metrics?: Json
          name?: string
          params?: Json
          source_session_ids?: string[]
          user_id?: string
        }
        Relationships: []
      }
      depth_state_labels: {
        Row: {
          created_at: string
          end_seconds: number
          id: string
          label: string
          note: string | null
          session_id: string
          start_seconds: number
          user_id: string
        }
        Insert: {
          created_at?: string
          end_seconds: number
          id?: string
          label: string
          note?: string | null
          session_id: string
          start_seconds: number
          user_id: string
        }
        Update: {
          created_at?: string
          end_seconds?: number
          id?: string
          label?: string
          note?: string | null
          session_id?: string
          start_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "depth_state_labels_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      eeg_epochs: {
        Row: {
          bands: Json
          created_at: string
          depth_components: Json | null
          depth_index: number | null
          depth_state: string | null
          entropy: Json | null
          id: number
          is_suppressed: boolean
          power_ratios: Json | null
          seizure_score: number
          session_id: string
          spectral_edge_95: number
          spectrum: Json
          suppression_ratio: number
          t_offset_seconds: number
          total_power: number
          user_id: string
        }
        Insert: {
          bands?: Json
          created_at?: string
          depth_components?: Json | null
          depth_index?: number | null
          depth_state?: string | null
          entropy?: Json | null
          id?: number
          is_suppressed?: boolean
          power_ratios?: Json | null
          seizure_score?: number
          session_id: string
          spectral_edge_95?: number
          spectrum?: Json
          suppression_ratio?: number
          t_offset_seconds: number
          total_power?: number
          user_id: string
        }
        Update: {
          bands?: Json
          created_at?: string
          depth_components?: Json | null
          depth_index?: number | null
          depth_state?: string | null
          entropy?: Json | null
          id?: number
          is_suppressed?: boolean
          power_ratios?: Json | null
          seizure_score?: number
          session_id?: string
          spectral_edge_95?: number
          spectrum?: Json
          suppression_ratio?: number
          t_offset_seconds?: number
          total_power?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "eeg_epochs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      eeg_events: {
        Row: {
          created_at: string
          detail: string | null
          duration_seconds: number
          id: number
          kind: string
          session_id: string
          severity: string
          t_offset_seconds: number
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          duration_seconds?: number
          id?: number
          kind: string
          session_id: string
          severity?: string
          t_offset_seconds: number
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          duration_seconds?: number
          id?: number
          kind?: string
          session_id?: string
          severity?: string
          t_offset_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "eeg_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      eeg_sessions: {
        Row: {
          admission_diagnosis: string | null
          age_band: string | null
          age_years: number | null
          case_code: string
          clinical_features: string[]
          context: string
          created_at: string
          device_name: string | null
          duration_seconds: number
          ended_at: string | null
          id: string
          location: string | null
          max_suppression_ratio: number
          mean_suppression_ratio: number
          notes: string | null
          seizure_alerts: number
          sex: string | null
          started_at: string
          suppression_seconds: number
          user_id: string
        }
        Insert: {
          admission_diagnosis?: string | null
          age_band?: string | null
          age_years?: number | null
          case_code: string
          clinical_features?: string[]
          context?: string
          created_at?: string
          device_name?: string | null
          duration_seconds?: number
          ended_at?: string | null
          id?: string
          location?: string | null
          max_suppression_ratio?: number
          mean_suppression_ratio?: number
          notes?: string | null
          seizure_alerts?: number
          sex?: string | null
          started_at?: string
          suppression_seconds?: number
          user_id: string
        }
        Update: {
          admission_diagnosis?: string | null
          age_band?: string | null
          age_years?: number | null
          case_code?: string
          clinical_features?: string[]
          context?: string
          created_at?: string
          device_name?: string | null
          duration_seconds?: number
          ended_at?: string | null
          id?: string
          location?: string | null
          max_suppression_ratio?: number
          mean_suppression_ratio?: number
          notes?: string | null
          seizure_alerts?: number
          sex?: string | null
          started_at?: string
          suppression_seconds?: number
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

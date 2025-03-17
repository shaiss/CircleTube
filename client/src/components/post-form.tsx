import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertPostSchema } from "@shared/schema";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface PostFormProps {
  defaultCircleId?: number;
}

export function PostForm({ defaultCircleId }: PostFormProps) {
  const { user } = useAuth();

  const { data: circles } = useQuery({
    queryKey: ["/api/circles"],
    enabled: !!user && !defaultCircleId, // Only fetch circles if not in a specific circle view
  });

  const form = useForm({
    resolver: zodResolver(insertPostSchema),
    defaultValues: {
      content: "",
      circleId: defaultCircleId ? defaultCircleId.toString() : "",
    },
  });

  const createPostMutation = useMutation({
    mutationFn: async (data: { content: string; circleId: string }) => {
      const circleId = defaultCircleId || parseInt(data.circleId);
      if (isNaN(circleId)) {
        throw new Error("Invalid circle ID");
      }

      const res = await apiRequest("POST", "/api/posts", {
        content: data.content,
        circleId,
      });
      return res.json();
    },
    onSuccess: (_, variables) => {
      const circleId = defaultCircleId || parseInt(variables.circleId);
      queryClient.invalidateQueries({ queryKey: [`/api/circles/${circleId}/posts`] });
      form.reset({
        content: "",
        circleId: defaultCircleId ? defaultCircleId.toString() : "",
      });
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((data) => createPostMutation.mutate(data))}>
        <Card>
          <CardContent className="pt-6">
            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea
                      placeholder="What's on your mind?"
                      className="min-h-[100px]"
                      {...field}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter className="flex justify-between items-center">
            {!defaultCircleId && (
              <FormField
                control={form.control}
                name="circleId"
                render={({ field }) => (
                  <FormItem className="w-[200px]">
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select circle" />
                      </SelectTrigger>
                      <SelectContent>
                        {circles?.map((circle) => (
                          <SelectItem key={circle.id} value={circle.id.toString()}>
                            <span className="flex items-center gap-2">
                              <span>{circle.icon}</span>
                              <span>{circle.name}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            )}
            <Button 
              type="submit" 
              className={!defaultCircleId ? "" : "ml-auto"}
              disabled={createPostMutation.isPending}
            >
              {createPostMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Post
            </Button>
          </CardFooter>
        </Card>
      </form>
    </Form>
  );
}